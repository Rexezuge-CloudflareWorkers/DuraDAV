/**
 * `apps/background/src/dav/methods/LockMethods.ts` — LOCK and UNLOCK.
 *
 * Two defects this file already fixed are pinned here, because both are the kind
 * that look correct in review:
 *
 * - The LOCK response used to echo **every** active lock on the path, handing a
 *   client that had just taken one lock the write tokens of every other client's
 *   lock on the same collection. Those tokens authorise DELETE/COPY/MOVE/PROPPATCH.
 * - UNLOCK resolved its target with `token LIKE '%…%'`. `%` and `_` are LIKE
 *   metacharacters, so a `Lock-Token` of `<urn:uuid: %>` built `%%%` and deleted
 *   *every* lock on the path.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleLock, handleUnlock } from '../apps/background/src/dav/methods/LockMethods';
import { BASES, fakeLocks, fakeRepo } from './helpers/dav-fakes';
import type { FakeRepo } from './helpers/dav-fakes';

const URL_BASE = 'https://dav.example.com/alice/photos';

/**
 * A `dav_locks` table that answers the queries `lockPhases` issues.
 *
 * **Stateful on DELETE**: the lock-null cleanup in `handleUnlock` reads
 * `readLocks` *after* deleting, to decide whether the resource still has a lock.
 * A fake that keeps returning the deleted row makes that branch unreachable, so
 * the row is removed for real.
 */
function fakeSql(initialRows: Array<Record<string, unknown>> = []) {
  const rows = [...initialRows];
  const exec = vi.fn((sql: string, ...bindings: unknown[]) => {
    if (sql.startsWith('DELETE FROM dav_locks')) {
      const index = rows.findIndex((row) => row['token'] === bindings[0]);
      if (index !== -1) rows.splice(index, 1);
      return { toArray: () => [] };
    }
    if (sql.includes('SELECT') && sql.includes('dav_locks')) {
      const path = String(bindings[0]);
      // `readLocks` filters on `expires_at > Date.now()` (milliseconds); the
      // UNLOCK candidate lookup does not filter on expiry at all. Only apply the
      // expiry filter when the query actually has that second binding.
      const now = typeof bindings[1] === 'number' ? bindings[1] : null;
      return {
        toArray: () => rows.filter((row) => String(row['path']) === path && (now === null || Number(row['expires_at'] ?? now) > now)),
      };
    }
    return { toArray: () => [] };
  });
  return { exec };
}

function seeded(): FakeRepo {
  return fakeRepo({
    'a.txt': { kind: 'file', bytes: new Uint8Array(), meta: { etag: '"a"' } },
    'empty.txt': { kind: 'file', bytes: new Uint8Array(), meta: { etag: '"e"' } },
    dir: { kind: 'directory' },
  });
}

/**
 * A `lockinfo` body.
 *
 * The elements are unprefixed on purpose: `parseLockRequest` recognises the
 * scope and lock type with `/<shared\b/` and `/<write\b/`, which match the
 * local name as RFC 4918 defines `DAV:` elements in the default namespace — the
 * form real clients send. A `D:`-prefixed body is not recognised, and is
 * refused with a `400`.
 */
const lockBody = (scope: 'exclusive' | 'shared' = 'exclusive') =>
  `<?xml version="1.0" encoding="utf-8"?><lockinfo xmlns="DAV:"><lockscope><${scope}/></lockscope><locktype><write/></locktype><owner>tester</owner></lockinfo>`;

function lock(innerPath: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${URL_BASE}/${innerPath}`, {
    method: 'LOCK',
    body,
    headers: { 'Content-Type': 'application/xml', ...headers },
  });
}

function unlock(innerPath: string, token?: string): Request {
  return new Request(`${URL_BASE}/${innerPath}`, {
    method: 'UNLOCK',
    headers: token === undefined ? {} : { 'Lock-Token': token },
  });
}

/**
 * Assemble `LockDeps`.
 *
 * The repo is wrapped rather than spread: `{ ...repo }` copies own properties
 * only, so every prototype method (`statInner`, `requireRecursive`, …) would be
 * missing and the handler would fail on `deps.repo.statInner is not a function`
 * rather than on anything meaningful.
 */
function deps(repo: FakeRepo, sql: ReturnType<typeof fakeSql>, options: { lockNull?: boolean } = {}) {
  repo.lockNull = options.lockNull === true;
  return {
    repo,
    locks: fakeLocks(),
    sql,
    writeEmptyFile: vi.fn(() => Promise.resolve(true)),
    statIsDirectory: (innerPath: string) => repo.statInner(innerPath).isDirectory,
    unlink: vi.fn(),
  };
}

describe('handleLock', () => {
  it('201s a new exclusive lock and returns a Lock-Token', async () => {
    const repo = seeded();
    const sql = fakeSql();
    const response = await handleLock(lock('a.txt', lockBody()), 'a.txt', BASES, deps(repo, sql) as never);
    expect(response.status).toBe(201);
    expect(response.headers.get('Lock-Token')).toMatch(/^<urn:uuid:[0-9a-f-]+>$/);
    expect(sql.exec).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO dav_locks'), expect.anything(), 'a.txt', expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it('200s a refresh with an empty body', async () => {
    const repo = seeded();
    const token = crypto.randomUUID();
    const sql = fakeSql([
      { token, path: 'a.txt', scope: 'exclusive', depth: '0', owner: 'tester', timeout: 3600, // `expires_at` is compared against `Date.now()` (milliseconds) by the
      // `readLocks` query, not against seconds.
      expires_at: Date.now() + 3_600_000, root: '/alice/photos/a.txt' },
    ]);
    const response = await handleLock(lock('a.txt', '', { 'If': `(<urn:uuid:${token}>)` }), 'a.txt', BASES, deps(repo, sql) as never);
    expect(response.status).toBe(200);
    expect(sql.exec).toHaveBeenCalledWith(expect.stringContaining('UPDATE dav_locks'), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), token);
  });

  it('400s Depth: infinity on a non-collection', async () => {
    const repo = seeded();
    const sql = fakeSql();
    const response = await handleLock(lock('a.txt', lockBody(), { Depth: 'infinity' }), 'a.txt', BASES, deps(repo, sql) as never);
    expect(response.status).toBe(400);
  });

  it('400s an invalid Depth header', async () => {
    const repo = seeded();
    const sql = fakeSql();
    const response = await handleLock(lock('a.txt', lockBody(), { Depth: '2' }), 'a.txt', BASES, deps(repo, sql) as never);
    expect(response.status).toBe(400);
  });

  it('423s when the target is locked by another client', async () => {
    const repo = seeded();
    const response = await handleLock(
      lock('a.txt', lockBody()),
      'a.txt',
      BASES,
      { ...deps(repo, fakeSql()), locks: fakeLocks({ lockedPaths: ['a.txt'] }) } as never,
    );
    expect(response.status).toBe(423);
  });

  it('500s when the lock row cannot be written', async () => {
    // A LOCK reporting success with no stored row leaves the client's token
    // authorising nothing, and every later write unblocked.
    const repo = seeded();
    const sql = { exec: vi.fn(() => { throw new Error('SQLITE_BUSY'); }) };
    const response = await handleLock(lock('a.txt', lockBody()), 'a.txt', BASES, deps(repo, sql as never) as never);
    expect(response.status).toBe(500);
  });

  it('REPORTS ONLY the lock this request created', async () => {
    // The capability leak: echoing every active lock on the path handed a
    // client the write tokens of every other client's lock on it. A *shared*
    // request is used so the pre-existing lock does not simply 423 the request
    // — the point is what the success body contains, not whether it succeeds.
    const repo = seeded();
    const other = crypto.randomUUID();
    const sql = fakeSql([
      { token: other, path: 'dir', scope: 'shared', depth: '0', owner: 'someone-else', timeout: 3600, expires_at: Date.now() + 3_600_000, root: '/alice/photos/dir' },
    ]);
    const response = await handleLock(lock('dir', lockBody('shared')), 'dir', BASES, deps(repo, sql) as never);
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain(other);
    expect(body).not.toContain('someone-else');
    // Its own token is present, so the assertion above is not vacuous.
    expect(body).toContain(response.headers.get('Lock-Token')?.replaceAll(/[<>]/g, '') ?? '');
  });

  it('423s a new exclusive lock where a shared one already exists', async () => {
    const repo = seeded();
    const sql = fakeSql([
      { token: crypto.randomUUID(), path: 'dir', scope: 'shared', depth: '0', owner: 'someone-else', timeout: 3600, expires_at: Date.now() + 3_600_000, root: '/alice/photos/dir' },
    ]);
    const response = await handleLock(lock('dir', lockBody('exclusive')), 'dir', BASES, deps(repo, sql) as never);
    expect(response.status).toBe(423);
  });
});

describe('handleUnlock', () => {
  const stored = (token: string, path = 'a.txt') => ({ token, path });

  it('204s and deletes the named lock', async () => {
    const repo = seeded();
    const token = crypto.randomUUID();
    const sql = fakeSql([stored(token)]);
    const response = await handleUnlock(unlock('a.txt', `<urn:uuid:${token}>`), 'a.txt', {
      repo: repo as never,
      sql: sql as never,
      unlink: vi.fn(),
    });
    expect(response.status).toBe(204);
    expect(sql.exec).toHaveBeenCalledWith('DELETE FROM dav_locks WHERE token = ?', token);
  });

  it('400s a missing Lock-Token header', async () => {
    const repo = seeded();
    const response = await handleUnlock(unlock('a.txt'), 'a.txt', { repo: repo as never, sql: fakeSql() as never, unlink: vi.fn() });
    expect(response.status).toBe(400);
  });

  it('409s an unknown token', async () => {
    const repo = seeded();
    const response = await handleUnlock(unlock('a.txt', '<urn:uuid:missing>'), 'a.txt', {
      repo: repo as never,
      sql: fakeSql([stored(crypto.randomUUID())]) as never,
      unlink: vi.fn(),
    });
    expect(response.status).toBe(409);
  });

  it('404s a missing resource', async () => {
    const repo = seeded();
    const response = await handleUnlock(unlock('missing.txt', '<urn:uuid:x>'), 'missing.txt', {
      repo: repo as never,
      sql: fakeSql() as never,
      unlink: vi.fn(),
    });
    expect(response.status).toBe(404);
  });

  it('does NOT delete every lock on LIKE metacharacters in the token', async () => {
    // `token LIKE '%…%'` turned `<urn:uuid: %>` into `%%%`, matching every row.
    // Resolution is by exact primary key now, so no pattern is ever built.
    const repo = seeded();
    const other = crypto.randomUUID();
    const sql = fakeSql([stored('some-other-token'), stored(other)]);
    const response = await handleUnlock(unlock('a.txt', '<urn:uuid: %>'), 'a.txt', {
      repo: repo as never,
      sql: sql as never,
      unlink: vi.fn(),
    });
    // No stored token normalises to `%`, so nothing matches.
    expect(response.status).toBe(409);
    expect(sql.exec).not.toHaveBeenCalledWith('DELETE FROM dav_locks WHERE token = ?', other);
  });

  it('removes a lock-null resource only when the flag is set', async () => {
    // RFC 4918 §7.3 plus the standard PUT(empty) -> LOCK -> UNLOCK cycle: an
    // ordinary empty document must survive its lock being released.
    const repo = seeded();
    const token = crypto.randomUUID();
    const unlink = vi.fn();
    const response = await handleUnlock(unlock('empty.txt', `<urn:uuid:${token}>`), 'empty.txt', {
      repo: Object.assign(repo, { lockNull: false }) as never,
      sql: fakeSql([stored(token, 'empty.txt')]) as never,
      unlink,
    });
    expect(response.status).toBe(204);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('removes a genuine lock-null resource', async () => {
    const repo = seeded();
    const token = crypto.randomUUID();
    const unlink = vi.fn();
    const response = await handleUnlock(unlock('empty.txt', `<urn:uuid:${token}>`), 'empty.txt', {
      repo: Object.assign(repo, { lockNull: true }) as never,
      sql: fakeSql([stored(token, 'empty.txt')]) as never,
      unlink,
    });
    expect(response.status).toBe(204);
    expect(unlink).toHaveBeenCalledWith('empty.txt');
  });
});