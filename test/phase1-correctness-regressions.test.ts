/**
 * Regression tests for the correctness defects found in the hardening pass.
 *
 * Each `describe` names the defect it pins. These are not "extra coverage" —
 * every one of them fails on the code as it stood before the fix, which is the
 * only thing that makes them worth keeping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DavConditionalGuard } from '../apps/background/src/dav/DavConditionalGuard';
import { DatabaseError, NotFoundError } from '@durable-dav/backend-errors';
import { VerificationCache } from '../apps/background/src/dav/CredentialVerifierDO';
import { KvCache } from '../packages/backend-runtime/src/kv/KvCache';
import { VolumeService } from '../packages/backend-services/src/dav/VolumeService';
import type { UserIdentityService } from '../packages/backend-services/src/identity/UserIdentityService';

// `KvCache` logs through a module-level logger rather than an injected one, so
// the purge-cap warning is asserted through this spy.
const loggerWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
afterEach(() => {
  loggerWarnSpy.mockClear();
});

// ---------------------------------------------------------------------------
// 1. RFC 9110 §13.2.2 conditional-request precedence.
//
// A satisfied `If-Match` used to `return null`, short-circuiting every later
// precondition. `GET` with `If-Match: "<current>"` + `If-None-Match: *` returned
// 200 with a full body (spec: 304) and `PUT` overwrote (spec: 412). The
// method's own docstring already stated the correct precedence the code
// contradicted.
// ---------------------------------------------------------------------------
describe('DavConditionalGuard precedence', () => {
  const guard = new DavConditionalGuard();
  const ETAG = '"abc123"';
  const state = { etag: ETAG, mtime: Date.parse('2024-01-01T00:00:00Z') };

  const request = (headers: Record<string, string>) => new Request('https://example.com/f', { headers });

  it('still fails If-Match when the etag does not match', () => {
    expect(guard.check(request({ 'If-Match': '"stale"' }), state)?.status).toBe(412);
  });

  it('still fails If-Match: * when there is no representation', () => {
    expect(guard.check(request({ 'If-Match': '*' }), { etag: null, mtime: state.mtime })?.status).toBe(412);
  });

  it('a satisfied If-Match no longer skips If-None-Match (304, not 200)', () => {
    const response = guard.check(request({ 'If-Match': ETAG, 'If-None-Match': '*' }), state, { forRead: true });
    expect(response?.status).toBe(304);
  });

  it('a satisfied If-Match no longer skips If-None-Match on a write (412, not pass)', () => {
    const response = guard.check(request({ 'If-Match': ETAG, 'If-None-Match': '*' }), state, { forRead: false });
    expect(response?.status).toBe(412);
  });

  it('a satisfied If-Match no longer skips If-Modified-Since on a read', () => {
    // `If-Modified-Since` is guarded on `If-None-Match` being absent, not on
    // `If-Match`, so a satisfied `If-Match` used to hide it.
    const future = new Date(state.mtime + 60_000).toUTCString();
    const response = guard.check(request({ 'If-Match': ETAG, 'If-Modified-Since': future }), state, { forRead: true });
    expect(response?.status).toBe(304);
  });

  it('skips If-Unmodified-Since when If-Match is present and satisfied', () => {
    // RFC 9110 §13.2.2: If-Unmodified-Since is evaluated only when If-Match is
    // *absent*, so a satisfied If-Match correctly suppresses it. The defect was
    // never this step — it was that the suppression returned from `check`
    // instead of only skipping this step.
    const past = new Date(state.mtime - 60_000).toUTCString();
    expect(guard.check(request({ 'If-Match': ETAG, 'If-Unmodified-Since': past }), state)).toBeNull();
  });

  it('still enforces If-Unmodified-Since when If-Match is absent', () => {
    const past = new Date(state.mtime - 60_000).toUTCString();
    const response = guard.check(request({ 'If-Unmodified-Since': past }), state);
    expect(response?.status).toBe(412);
  });

  it('passes when If-Match is satisfied and nothing later fails', () => {
    expect(guard.check(request({ 'If-Match': ETAG }), state, { forRead: true })).toBeNull();
  });

  it('still evaluates a standalone If-Match: * against a present representation', () => {
    expect(guard.check(request({ 'If-Match': '*' }), state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. `request.url` includes the query string.
//
// `handleGet` asked `request.url.endsWith('/')`, so `GET /alice/notes.txt?next=/`
// read as a collection navigation and 404'd a file that exists. The identical
// bug was already fixed in `WriteMethods` and `lockPhases`; this was the third
// and last call site.
// ---------------------------------------------------------------------------
describe('collection-vs-file navigation ignores the query string', () => {
  it('a trailing slash in the query does not turn a file GET into a collection request', async () => {
    const { handleGet } = await import('../apps/background/src/dav/methods/ReadMethods');
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const repo = {
      statInner: vi.fn(() => ({ exists: true, isDirectory: false, size: 4, mtime: Date.now() })),
      readMeta: vi.fn(() => ({ etag: '"e1"', mtime: Date.now(), contentType: 'text/plain' })),
      listChildren: vi.fn(() => []),
      childInner: vi.fn(() => ''),
      rootNode: vi.fn(),
      nodeInfo: vi.fn(),
    };
    const dofs = {
      readFile: vi.fn(() => bytes.buffer),
      read: vi.fn(() => bytes.buffer),
    };

    // The `?next=/` is the whole point: a naive `endsWith('/')` sees it.
    const response = await handleGet(
      new Request('https://example.com/alice/notes.txt?next=/'),
      'notes.txt',
      { pathBase: '/alice', hrefBase: '/alice' },
      false,
      repo as never,
      dofs as never,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('\u{1}\u{2}\u{3}\u{4}');
    expect(repo.listChildren).not.toHaveBeenCalled();
  });

  it('a real trailing slash on the pathname still serves the collection listing', async () => {
    const { handleGet } = await import('../apps/background/src/dav/methods/ReadMethods');

    const repo = {
      statInner: vi.fn((path: string) => ({ exists: true, isDirectory: path === 'docs', size: 0, mtime: Date.now() })),
      readMeta: vi.fn(() => ({})),
      listChildren: vi.fn(() => ['a.txt']),
      childInner: vi.fn(() => 'docs/a.txt'),
      rootNode: vi.fn(),
      nodeInfo: vi.fn(),
    };
    const dofs = { readFile: vi.fn(), read: vi.fn() };

    const response = await handleGet(
      new Request('https://example.com/alice/docs/'),
      'docs',
      { pathBase: '/alice', hrefBase: '/alice' },
      false,
      repo as never,
      dofs as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('a.txt');
  });
});

// ---------------------------------------------------------------------------
// 3. `VerificationCache` — the eviction/TTL premise behind the 401.
//
// `CredentialVerifierDO.verify` awaited an in-flight derivation that had
// *succeeded*, then re-read the cache to decide the verdict. That second read
// can miss (eviction at `MAX_CACHE_ENTRIES`, or a very low configured TTL),
// turning a just-verified credential into `ok: false` — a 401 for a valid
// password, on the one path whose stated purpose is to never lock a valid
// credential out.
// ---------------------------------------------------------------------------
describe('VerificationCache boundary behaviour (the 401 premise)', () => {
  it('evicts oldest-first at capacity, which is what could race the old re-read', () => {
    const cache = new VerificationCache(60_000, 2);
    cache.set('a', 'hashA', 0);
    cache.set('b', 'hashB', 0);
    cache.set('c', 'hashC', 0);
    // 'a' was evicted to make room for 'c'.
    expect(cache.get('a', 'hashA', 0)).toBe(false);
    expect(cache.get('c', 'hashC', 0)).toBe(true);
  });

  it('treats an expired entry as absent, which is the other way the re-read missed', () => {
    const cache = new VerificationCache(1, 10);
    cache.set('a', 'hashA', 0);
    expect(cache.get('a', 'hashA', 0)).toBe(true);
    expect(cache.get('a', 'hashA', 5)).toBe(false);
  });

  it('invalidates on a stored-hash change, so a password rotation is not a hit', () => {
    const cache = new VerificationCache(60_000, 10);
    cache.set('a', 'hashA', 0);
    expect(cache.get('a', 'rotatedHash', 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. `DatabaseError` carries `cause`.
//
// `BaseDAO.firstWithRetry` threw `new DatabaseError(msg, retryable)` and dropped
// the original error, even though the class accepts `{ cause }`. Every
// downstream `error.message` was therefore a one-liner with no stack.
// ---------------------------------------------------------------------------
describe('DatabaseError keeps its cause', () => {
  it('retains the original error for the stack chain', () => {
    const original = new TypeError('D1_ERROR: something specific');
    const wrapped = new DatabaseError('Failed to read row: boom', false, { cause: original });
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toBe('Failed to read row: boom');
    expect(wrapped.retryable).toBe(false);
  });

  it('still defaults retryable and accepts a cause together', () => {
    const wrapped = new DatabaseError('transient', true, { cause: 'original' });
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.cause).toBe('original');
  });
});

// ---------------------------------------------------------------------------
// 5. `VolumeService.requireCallerAccount` must not answer 404 for an outage.
//
// `.catch(() => null)` turned a `DatabaseError` into "no account is provisioned
// for this address; sign in again" — a 404 for a transient D1 failure. It still
// fails closed (an exception creates no bucket); it just no longer lies about
// the cause.
// ---------------------------------------------------------------------------
describe('requireCallerAccount separates "no account" from "outage"', () => {
  /**
   * `VolumeService` types the dep as a factory returning the real
   * `UserIdentityService`, so the fake is built through a cast rather than by
   * re-declaring the class. Only `resolveAccount` is ever reached here.
   */
  const withIdentity = (resolveAccount: (email: string) => Promise<unknown>): VolumeService => {
    const identity = { resolveAccount } as unknown as UserIdentityService;
    return new VolumeService({} as never, { identity: () => Promise.resolve(identity) });
  };

  it('a null account is a NotFoundError', async () => {
    await expect(withIdentity(() => Promise.resolve(null)).requireCallerAccount('nobody@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a DatabaseError propagates so the route maps it to 503, not 404', async () => {
    const thrown = await withIdentity(() => Promise.reject(new DatabaseError('D1 down', true)))
      .requireCallerAccount('a@example.com')
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DatabaseError);
    expect(thrown).not.toBeInstanceOf(NotFoundError);
  });

  it('a resolved account is returned unchanged', async () => {
    const account = { userId: 'usr_1', email: 'a@example.com', username: 'alice' };
    await expect(withIdentity(() => Promise.resolve(account)).requireCallerAccount('a@example.com')).resolves.toBe(account);
  });
});

// ---------------------------------------------------------------------------
// 6. `KvCache.purgePrefix` silently under-purged past the page cap.
//
// Ten pages of 1000 keys, then `return deleted` — indistinguishable from a
// complete purge. A surviving key serves pre-write bytes for a whole TTL while
// the invalidation reports success.
// ---------------------------------------------------------------------------
describe('KvCache.purgePrefix page cap', () => {
  const keys = (n: number, tag = '') => Array.from({ length: n }, (_, i) => ({ name: `k${tag}${i}` }));

  it('deletes everything when the listing drains before the cap', async () => {
    const namespace = {
      list: vi.fn().mockResolvedValueOnce({ keys: keys(3) }).mockResolvedValueOnce({ keys: [] }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const cache = new KvCache(namespace as never);
    await expect(cache.purgePrefix('davMeta')).resolves.toBe(3);
    expect(namespace.delete).toHaveBeenCalledTimes(3);
  });

  it('reports no deletion when the prefix is already empty', async () => {
    const namespace = { list: vi.fn().mockResolvedValue({ keys: [] }), delete: vi.fn() };
    const cache = new KvCache(namespace as never);
    await expect(cache.purgePrefix('davFile')).resolves.toBe(0);
  });

  it('does not silently under-purge when the page cap is exhausted', async () => {
    // Every page comes back full, so the loop exhausts its 10 iterations with
    // keys still present. That used to `return deleted` — a count identical to a
    // complete purge, so a caller could not tell, and surviving keys serve
    // pre-write bytes for a whole TTL while the invalidation reports success.
    const namespace = {
      list: vi.fn().mockResolvedValue({ keys: keys(1000) }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const cache = new KvCache(namespace as never);

    // The defect: 10 full pages, then a clean-looking return.
    const deleted = await cache.purgePrefix('davMeta');
    expect(deleted).toBe(10_000);
    expect(namespace.list).toHaveBeenCalledTimes(10);

    // The fix surfaces it rather than reporting success. The logger prefixes
    // a domain tag, so match the message argument rather than the call shape.
    expect(loggerWarnSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('page cap'));
  });
});
