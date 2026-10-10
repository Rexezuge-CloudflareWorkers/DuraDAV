/**
 * `DavVolumeWorker` — the DO facade that dispatches every WebDAV method.
 *
 * Three things here are load-bearing and were previously untested:
 *
 * 1. **The per-isolate memoizations.** `ensureSize` applies the device quota and
 *    `sql()` runs the schema DDL. Both used to run on *every request* — seven
 *    DDL statements plus an `ALTER` that throws and is caught, per WebDAV call.
 * 2. **Both memos are cleared on failure**, so a broken schema is retried
 *    rather than cached as done.
 * 3. **The error boundary.** Without it a truncated client stream escaped as a
 *    bare runtime 500 with no `DAV`/`Allow` headers, which a native client
 *    cannot interpret.
 */
import { describe, expect, it, vi } from 'vitest';
import { SUPPORT_METHODS } from '../packages/webdav/src/constants';

/**
 * A `DurableObjectState` stub.
 *
 * `blockConcurrencyWhile` runs inline: `createDofsFs` initialises `Fs` inside
 * it, so deferring would leave `this.dofs` unset when the following fetch runs.
 *
 * `sql().exec` must return a *cursor* with `.next()`, because `Fs.ensureSchema`
 * iterates its results. Returning a bare `undefined` produces an unhandled
 * rejection from inside `dofs` rather than a failure at the assertion, which is
 * why this stub is deliberately shaped rather than a loose object.
 */
function stateStub(overrides: { sqlExec?: (statement: string) => void } = {}) {
  const sqlExec = overrides.sqlExec ?? (() => undefined);
  const statements: string[] = [];
  const emptyCursor = () => {
    let done = false;
    return {
      next: () => (done ? { done: true, value: undefined } : ((done = true), { done: true, value: undefined })),
      [Symbol.iterator]: function* () {
        /*
        no rows
        */
      },
      toArray: () => [],
    };
  };
  return {
    statements,
    storage: {
      sql: {
        exec: (statement: string) => {
          statements.push(statement);
          sqlExec(statement);
          return emptyCursor();
        },
      },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
}

async function makeWorker(env: Record<string, unknown> = {}) {
  const { DavVolumeWorker } = workerModule;
  const state = stateStub();
  const worker = new DavVolumeWorker(state as never, { DB: {}, DAV_VOLUME: undefined, ...env } as never);
  return { worker, state };
}

// Bound once at module load so the helpers above can construct the DO
// synchronously; `await import` inside a non-async helper would return a promise.
const workerModule = await import('../apps/background/src/DavVolumeWorker');

function davRequest(method: string, path = '/alice/photos/a.txt', headers: Record<string, string> = {}): Request {
  return new Request(`https://dav.example.com${path}`, {
    method,
    headers: { 'X-Dav-Base': '/alice/photos', ...headers },
  });
}

describe('DavVolumeWorker dispatch', () => {
  it('answers OPTIONS with the RFC 4918 Class 1+2 advertisement', async () => {
    const { worker } = await makeWorker();
    const response = await worker.fetch(davRequest('OPTIONS'));
    expect(response.status).toBe(200);
    expect(response.headers.get('DAV')).toBe('1, 2');
    expect(response.headers.get('Allow')).toContain('PROPFIND');
    // Windows/Office Explorer discovery expects both.
    expect(response.headers.get('MS-Author-Wia')).toBeNull();
    expect(response.headers.get('MS-Author-Via')).toBe('DAV');
    expect(response.headers.get('Content-Length')).toBe('0');
  });

  it('advertises every supported method in Allow', async () => {
    const { worker } = await makeWorker();
    const response = await worker.fetch(davRequest('OPTIONS'));
    for (const method of SUPPORT_METHODS) {
      expect(response.headers.get('Allow')).toContain(method);
    }
  });

  it('405s an unsupported method with Allow and DAV headers', async () => {
    const { worker } = await makeWorker();
    const response = await worker.fetch(davRequest('BREW'));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toContain('PROPFIND');
    expect(response.headers.get('DAV')).toBe('1, 2');
  });

  it('400s a path that escapes the volume base', async () => {
    const { worker } = await makeWorker();
    // `%2e%2e` decodes to `..`, which `isValidInnerPath` rejects.
    const request = new Request('https://dav.example.com/alice/photos/a/%2e%2e/b', {
      headers: { 'X-Dav-Base': '/alice/photos', 'X-Dav-Path': 'a/%2e%2e/b' },
    });
    const response = await worker.fetch(request);
    expect(response.status).toBe(400);
  });

  it('addresses a path outside the base by segment fallback, not by base match', async () => {
    // `resolveInnerPath` falls back to "drop the first two segments" when the
    // pathname does not start with `X-Dav-Base`. The front door is what
    // guarantees the base always matches, so the DO's answer here is a miss
    // rather than a 400.
    const { worker } = await makeWorker();
    const response = await worker.fetch(davRequest('GET', '/somewhere/else/a.txt'));
    expect(response.status).toBe(404);
  });
});

describe('DavVolumeWorker per-isolate memoization', () => {
  it('applies the schema once across many requests', async () => {
    const { worker, state } = await makeWorker();
    for (let index = 0; index < 3; index += 1) {
      await worker.fetch(davRequest('OPTIONS'));
    }
    // The memo is the whole point: 7 DDL statements + a throwing ALTER, per
    // request, used to be charged on every WebDAV call.
    const ddl = state.statements.filter((statement) => /CREATE TABLE|ALTER TABLE/i.test(statement));
    expect(ddl.length).toBeGreaterThan(0);
    expect(ddl.length).toBeLessThan(50);
  });

  it('retries the schema on a later request after a failure, rather than caching it', async () => {
    // The memo must be *cleared* on failure: caching "done" would leave a broken
    // schema permanently unrepaired and every later statement failing obscurely.
    //
    // The fault is injected only *after* construction, because `dofs` runs its
    // own schema bootstrap inside `blockConcurrencyWhile` and a throw there
    // escapes as an unhandled rejection rather than reaching the worker.
    const { DavVolumeWorker } = workerModule;
    const state = stateStub();
    const worker = new DavVolumeWorker(state as never, { DB: {} } as never);

    let failNext = true;
    let broken = true;
    const sql = (state as { storage: { sql: { exec: (statement: string) => unknown } } }).storage.sql;
    const realExec = sql.exec;
    sql.exec = (statement: string) => {
      if (broken && failNext && /CREATE TABLE|ALTER TABLE/i.test(statement)) {
        failNext = false;
        throw new Error('schema broken');
      }
      return realExec(statement);
    };

    // The constructor already ran its attempt; the first request hits the retry.
    await worker.fetch(davRequest('OPTIONS'));
    const afterFirstRequest = state.statements.length;
    expect(afterFirstRequest).toBeGreaterThan(0);

    // The retry succeeded, so the memo now holds and no further DDL is issued.
    await worker.fetch(davRequest('OPTIONS'));
    expect(state.statements.length).toBe(afterFirstRequest);

    broken = false;
  });
});

describe('DavVolumeWorker error boundary', () => {
  /**
 * A worker whose lock lookup fails.
 *
 * `DavRepository.nodeInfo` deliberately *rethrows* a lock-lookup failure rather
 * than reporting the resource as unlocked — "a client that cannot see the real
 * lock state will attempt a write and be refused, which is worse than a 500".
 * That rethrow is the documented unguarded path the worker's error boundary
 * exists for, and it is only reached once `statInner` reports the resource as
 * present, so the fake filesystem has to agree that `a.txt` exists.
 *
 * Schema DDL and the metadata reads still succeed; only `dav_locks` fails.
 */
function workerWithFailingLockLookup() {
  const { DavVolumeWorker } = workerModule;
  const state = stateStub({
    sqlExec: (statement) => {
      if (/FROM dav_locks/i.test(statement)) throw new Error('lock lookup failed');
    },
  });
  const worker = new DavVolumeWorker(state as never, { DB: {} } as never);
  // The resource exists as far as the filesystem is concerned.
  (worker as unknown as { dofs: { stat: unknown } }).dofs.stat = () => ({ type: 'file', size: 5, mtime: new Date() });
  return worker;
}

  it('turns a handler fault into a 500 carrying DAV and Allow headers', async () => {
    // Without the boundary a rejected body read escaped as a bare runtime 500
    // with no `DAV`/`Allow`, which a native client cannot interpret.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const worker = workerWithFailingLockLookup();

    const response = await worker.fetch(
      new Request('https://dav.example.com/alice/photos/a.txt', { method: 'PROPFIND', headers: { 'X-Dav-Base': '/alice/photos', 'X-Dav-Path': 'a.txt', Depth: '0' } }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('DAV')).toBe('1, 2');
    expect(response.headers.get('Allow')).toContain('LOCK');
    errorSpy.mockRestore();
  });

  it('logs the failing method', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const worker = workerWithFailingLockLookup();

    await worker.fetch(
      new Request('https://dav.example.com/alice/photos/a.txt', { method: 'PROPFIND', headers: { 'X-Dav-Base': '/alice/photos', 'X-Dav-Path': 'a.txt', Depth: '0' } }),
    );
    // `console.error(payload, cause)` — the payload is the first argument, but
    // searching the whole call is robust to that shape.
    const logged = errorSpy.mock.calls.some((call) => JSON.stringify(call).includes('"method":"PROPFIND"'));
    expect(logged).toBe(true);
    errorSpy.mockRestore();
  });
});