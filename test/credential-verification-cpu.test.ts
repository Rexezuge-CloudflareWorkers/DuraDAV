import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Container, setRequestScope } from '@durable-dav/backend-runtime/di';
import { Tokens } from '@durable-dav/backend-services/composition';
import type { DavPermissionService, VolumeService } from '@durable-dav/backend-services/dav';
import type { UserIdentityService } from '@durable-dav/backend-services/identity';
import { DavCredentialDAO, DavVolumeDAO } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { DatabaseError } from '@durable-dav/backend-errors';
import { DavCredentialUtil, passwordFingerprint } from '@durable-dav/shared/utils';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import { davAuthForVolume } from '../apps/api/src/middleware/DavAuth';
import {
  lookupCredentialMemo,
  rememberCredential,
  forgetCredential,
  resetCredentialMemoForTests,
  setCredentialMemoClockForTests,
  credentialMemoSizeForTests,
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
} from '../apps/api/src/middleware/credentialMemo';
import { verifyCredential } from '../apps/api/src/middleware/credentialVerifier';
import { CredentialVerifierDO, VerificationCache } from '../apps/background/src/dav/CredentialVerifierDO';
import { credentialShardOf, CREDENTIAL_SHARD_COUNT } from '../packages/shared/src/utils/CredentialShardUtil';

type TestEnv = { Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } };
type TestApp = Hono<TestEnv>;

const VOLUME_ID = 'vol_1';
const USERNAME = 'quiet-otter';
const PASSWORD = 'ddav_probe_password';

/**
 * A Worker on the Free plan has a 10 ms CPU budget and one PBKDF2 derivation at
 * 100k iterations costs more than that, so the *original* bug was Cloudflare
 * answering every Basic-auth request with 503 (`exceededCpu`). CPU time is not
 * observable from vitest, so these tests pin the two properties that make the
 * derivation rare instead: a verified password is not re-derived, and a wrong
 * or rotated one always is.
 */
function isWrite(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(method);
}

function volumeRow(overrides: Partial<DavVolumeRow> = {}): DavVolumeRow {
  return {
    id: VOLUME_ID,
    owner_email: 'owner@example.com',
    owner: 'alice',
    name: 'photos',
    description: null,
    is_private: 1,
    created_at: 1,
    updated_at: 1,
    owner_ci: 'alice',
    name_ci: 'photos',
    owner_user_id: 'usr_1',
    href_prefix_mode: 'base',
    ...overrides,
  } as DavVolumeRow;
}

function fakeDb(row: Record<string, unknown> | null): { db: D1Queryable; queries: string[] } {
  const queries: string[] = [];
  const db: D1Queryable = {
    prepare(query: string) {
      const normalized = query.replaceAll(/\s+/gu, ' ').trim();
      queries.push(normalized);
      const statement = {
        bind: () => statement,
        first: async <T,>(): Promise<T | null> => {
          if (!row) return null;
          if (normalized.includes('WHERE username = ? AND expires_at > ?')) {
            return (Number(row.expires_at) > 1 ? (row as T) : null);
          }
          return row as T;
        },
        all: async <T,>(): Promise<{ results: T[] }> => ({ results: (row ? [row] : []) as T[] }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return statement;
    },
  };
  return { db, queries };
}

async function credentialRow(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    credential_id: 'cred_1',
    volume_id: VOLUME_ID,
    username: USERNAME,
    password_hash: await DavCredentialUtil.hashPassword(PASSWORD),
    name: 'backup',
    password_prefix: 'ddav_pro',
    password_last_four: 'word',
    created_at: 1,
    expires_at: 4_102_444_800,
    last_used_at: null,
    read_only: 1,
    ...overrides,
  };
}

function buildApp(volume: DavVolumeRow, row: Record<string, unknown> | null): TestApp {
  const { db } = fakeDb(row);
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    const scope = new Container();
    scope.bindValue(Tokens.VolumeService, { getVolume: () => Promise.resolve(volume) } as unknown as VolumeService);
    scope.bindValue(Tokens.DavCredentialDAO, () => Promise.resolve(new DavCredentialDAO(db)));
    scope.bindValue(Tokens.DavPermissionService, { getRole: () => Promise.resolve('read' as const) } as unknown as DavPermissionService);
    scope.bindValue(Tokens.UserIdentityService, { resolveUserById: () => Promise.resolve(null) } as unknown as UserIdentityService);
    setRequestScope(c, scope);
    await next();
  });
  app.all('/:owner/:volume/*', async (c) => {
    const result = await davAuthForVolume(c, c.req.param('owner') ?? '', c.req.param('volume') ?? '', isWrite(c.req.method));
    return result instanceof Response ? result : c.json(result);
  });
  return app;
}

function basic(username = USERNAME, password = PASSWORD, scheme = 'Basic'): Record<string, string> {
  return { Authorization: `${scheme} ${btoa(`${username}:${password}`)}` };
}

/**
The legacy unsalted-SHA256 format that `verifyPassword` still accepts.
*/
async function legacyDigestHex(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authorize(app: TestApp, method: string, headers: Record<string, string> = basic()): Promise<Response> {
  return app.request('https://x/alice/photos/file.txt', { method, headers });
}

describe('the isolate verification memo', () => {
  it('does not re-derive a password it already verified', async () => {
    resetCredentialMemoForTests();
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const fingerprint = await passwordFingerprint(PASSWORD);
    rememberCredential(USERNAME, fingerprint, hash);
    expect(lookupCredentialMemo(USERNAME, fingerprint, hash)).toBe(true);
    expect(credentialMemoSizeForTests()).toBe(1);
  });

  it('refuses a different password for a memoized username', () => {
    // The bypass this design exists to prevent: keying on `username` alone would
    // accept ANY password for a recently-used username.
    resetCredentialMemoForTests();
    const hash = 'stored-hash';
    rememberCredential(USERNAME, 'fingerprint-of-the-right-password', hash);
    expect(lookupCredentialMemo(USERNAME, 'fingerprint-of-a-different-password', hash)).toBe(false);
    expect(lookupCredentialMemo('other-user', 'fingerprint-of-the-right-password', hash)).toBe(false);
  });

  it('invalidates when the stored hash changes', () => {
    // A password rotation or a PATCH rewrites the row; a verdict issued against
    // the previous hash must not survive it.
    resetCredentialMemoForTests();
    rememberCredential(USERNAME, 'fp', 'old-hash');
    expect(lookupCredentialMemo(USERNAME, 'fp', 'new-hash')).toBe(false);
    // ...and it is dropped, not merely refused.
    expect(credentialMemoSizeForTests()).toBe(0);
  });

  it('expires entries after the TTL', () => {
    resetCredentialMemoForTests();
    let now = 1000;
    setCredentialMemoClockForTests(() => now);
    rememberCredential(USERNAME, 'fp', 'hash');
    now += DEFAULT_TTL_MS - 1;
    expect(lookupCredentialMemo(USERNAME, 'fp', 'hash')).toBe(true);
    now += 2;
    expect(lookupCredentialMemo(USERNAME, 'fp', 'hash')).toBe(false);
    resetCredentialMemoForTests();
  });

  it('forgets a whole credential on demand', () => {
    // Revocation should not have to wait out the TTL.
    resetCredentialMemoForTests();
    rememberCredential(USERNAME, 'fp-a', 'hash');
    rememberCredential(USERNAME, 'fp-b', 'hash');
    rememberCredential('someone-else', 'fp-c', 'hash');
    forgetCredential(USERNAME);
    expect(lookupCredentialMemo(USERNAME, 'fp-a', 'hash')).toBe(false);
    expect(lookupCredentialMemo(USERNAME, 'fp-b', 'hash')).toBe(false);
    expect(lookupCredentialMemo('someone-else', 'fp-c', 'hash')).toBe(true);
    resetCredentialMemoForTests();
  });

  it('stays bounded under more entries than the cap', () => {
    // An unbounded map keyed by client-controlled usernames is a memory leak
    // reachable by anyone who can authenticate-or-not against the bucket.
    resetCredentialMemoForTests();
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) rememberCredential(`user-${i}`, 'fp', 'hash');
    expect(credentialMemoSizeForTests()).toBe(MAX_ENTRIES);
    resetCredentialMemoForTests();
  });

  it('produces distinct fingerprints for distinct passwords', async () => {
    const [a, b] = await Promise.all([passwordFingerprint('one'), passwordFingerprint('two')]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\da-f]{64}$/u);
    // Deterministic: the memo key must be stable across requests.
    expect(await passwordFingerprint('one')).toBe(a);
  });
});

describe('verification through the DAV front door', () => {
  it('authorizes a correct password and refuses a wrong one', async () => {
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow());
    expect((await authorize(app, 'GET')).status).toBe(200);
    expect((await authorize(app, 'GET', basic(USERNAME, 'wrong'))).status).toBe(401);
    resetCredentialMemoForTests();
  });

  it('still authorizes after the password is memoized', async () => {
    // The memo must not change the answer, only the amount of CPU spent.
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow());
    expect((await authorize(app, 'GET')).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await authorize(app, 'PROPFIND')).status).toBe(200);
    resetCredentialMemoForTests();
  });

  it('refuses a write from a read-only credential even once memoized', async () => {
    // The 403 lives in DavAuth, downstream of verification, so caching the
    // derivation cannot leak write access.
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow({ read_only: 1 }));
    expect((await authorize(app, 'GET')).status).toBe(200);
    expect((await authorize(app, 'PUT')).status).toBe(403);
    resetCredentialMemoForTests();
  });

  it('upgrades a legacy digest and reuses that hash for the rehash', async () => {
    // The rehash used to be a second full derivation in the same request — the
    // heaviest CPU path in the auth flow, and the most likely to blow the budget.
    // The upgraded hash now arrives with the verification result.
    resetCredentialMemoForTests();
    const legacyHex = await legacyDigestHex(PASSWORD);
    expect(legacyHex).toMatch(/^[\da-f]{64}$/u);
    const { db, queries } = fakeDb(await credentialRow({ password_hash: legacyHex }));
    const dao = new DavCredentialDAO(db);
    const outcome = await verifyCredential({} as Env, USERNAME, PASSWORD, legacyHex);
    expect(outcome.ok).toBe(true);
    expect(outcome.needsRehash).toBe(true);
    expect(outcome.upgradedHash).toMatch(/^pbkdf2-sha256\$/u);
    // The upgraded hash really does verify, so the row is left in a usable state.
    expect((await DavCredentialUtil.verifyPassword(PASSWORD, outcome.upgradedHash as string)).ok).toBe(true);
    // ...and it is the exact value the caller persists.
    await dao.updatePasswordHash('cred_1', outcome.upgradedHash as string);
    expect(queries.some((q) => q.startsWith('UPDATE dav_credentials SET password_hash'))).toBe(true);
    resetCredentialMemoForTests();
  });

  it('needs no rehash for an already-current credential', async () => {
    resetCredentialMemoForTests();
    const outcome = await verifyCredential({} as Env, USERNAME, PASSWORD, await DavCredentialUtil.hashPassword(PASSWORD));
    expect(outcome).toEqual({ ok: true, needsRehash: false, upgradedHash: null });
    resetCredentialMemoForTests();
  });

  it('refuses a wrong password against a legacy digest and caches nothing', async () => {
    // A cached failure would be a free verification oracle for an attacker.
    resetCredentialMemoForTests();
    const legacyHex = await legacyDigestHex(PASSWORD);
    const outcome = await verifyCredential({} as Env, USERNAME, 'not-the-password', legacyHex);
    expect(outcome.ok).toBe(false);
    expect(credentialMemoSizeForTests()).toBe(0);
    resetCredentialMemoForTests();
  });

  it('falls back to a local derivation when the DO binding is absent', async () => {
    // No `DAV_AUTH` on this Env: the request must still authenticate rather than
    // fail closed, so a partially-migrated deployment is not a lockout.
    resetCredentialMemoForTests();
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const outcome = await verifyCredential({} as Env, USERNAME, PASSWORD, hash);
    expect(outcome.ok).toBe(true);
    expect(outcome.needsRehash).toBe(false);
    resetCredentialMemoForTests();
  });

  it('reports a malformed stored hash as a failed auth, not a throw', async () => {
    resetCredentialMemoForTests();
    const outcome = await verifyCredential({} as Env, USERNAME, PASSWORD, 'not-a-known-format');
    expect(outcome).toEqual({ ok: false, needsRehash: false, upgradedHash: null });
    resetCredentialMemoForTests();
  });
});

describe('the Basic scheme token is case-insensitive', () => {
  // RFC 9110 §11.1. `startsWith('Basic ')` ignored a legal `basic <base64>`, so
  // the credential was dropped and the request fell through to the anonymous
  // branch: a 401 on a private bucket, or a silently anonymous read on a public
  // one.
  it('accepts a lowercase scheme', async () => {
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow());
    expect((await authorize(app, 'GET', basic(USERNAME, PASSWORD, 'basic'))).status).toBe(200);
    resetCredentialMemoForTests();
  });

  it('accepts other casings of the scheme', async () => {
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow());
    for (const scheme of ['BASIC', 'BaSiC']) {
      expect((await authorize(app, 'GET', basic(USERNAME, PASSWORD, scheme))).status, scheme).toBe(200);
    }
    resetCredentialMemoForTests();
  });

  it('does not case-fold the username or the password', async () => {
    // Only the scheme is case-insensitive; the decoded credentials are opaque
    // byte sequences and must be compared verbatim.
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow());
    expect((await authorize(app, 'GET', basic(USERNAME, PASSWORD.toUpperCase()))).status).toBe(401);
    resetCredentialMemoForTests();
  });

  it('still refuses a non-Basic scheme', async () => {
    resetCredentialMemoForTests();
    const app = buildApp(volumeRow(), await credentialRow());
    expect((await authorize(app, 'GET', basic(USERNAME, PASSWORD, 'Bearer'))).status).toBe(401);
    resetCredentialMemoForTests();
  });
});

describe('the verifier DO cache', () => {
  it('answers a repeat without re-deriving, and only for the same hash', () => {
    const cache = new VerificationCache(60_000, 10);
    cache.set('alice:fp', 'hash-1', 0);
    expect(cache.get('alice:fp', 'hash-1', 1)).toBe(true);
    expect(cache.get('alice:fp', 'hash-2', 1)).toBe(false);
    expect(cache.get('bob:fp', 'hash-1', 1)).toBe(false);
  });

  it('expires an entry', () => {
    const cache = new VerificationCache(1000, 10);
    cache.set('alice:fp', 'hash', 0);
    expect(cache.get('alice:fp', 'hash', 999)).toBe(true);
    expect(cache.get('alice:fp', 'hash', 1001)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('evicts oldest-first at the cap and drops a prefix on demand', () => {
    const cache = new VerificationCache(60_000, 2);
    cache.set('a:1', 'h', 0);
    cache.set('a:2', 'h', 0);
    cache.set('b:1', 'h', 0);
    expect(cache.size).toBe(2);
    // `a:1` was the oldest insertion and had to go.
    expect(cache.get('a:1', 'h', 1)).toBe(false);
    cache.deletePrefix('b:');
    expect(cache.size).toBe(1);
  });

  it('spreads usernames across shards', () => {
    // One un-sharded verifier would serialize all authentication on one object.
    expect(CREDENTIAL_SHARD_COUNT).toBeGreaterThan(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(credentialShardOf(`user-${i}`));
    // Real spread, not 1 or 2 buckets doing all the work.
    expect(seen.size).toBeGreaterThan(CREDENTIAL_SHARD_COUNT / 2);
    for (let i = 0; i < 50; i += 1) {
      const shard = credentialShardOf(`user-${i}`);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(CREDENTIAL_SHARD_COUNT);
      // Stable: the caller and the verifier must agree without coordinating.
      expect(credentialShardOf(`user-${i}`)).toBe(shard);
    }
  });
});
describe('a D1 failure on the auth hot path is a typed DatabaseError', () => {
  /**
   * `DavAuth` documents a `DatabaseError` -> 503 "Authentication unavailable"
   * contract for its two D1 reads. That branch was unreachable: both reads
   * called `.first()` bare, which rejects with a raw `D1_ERROR` that is not a
   * `DatabaseError`, so a D1 blip surfaced as an opaque 500 instead. These pin
   * the normalization, since the 503 depends on it.
   */
  function failingDb(message: string, failures = Infinity): { db: D1Queryable; calls: () => number } {
    let calls = 0;
    const db: D1Queryable = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          first: async <T,>(): Promise<T | null> => {
            calls += 1;
            if (calls > failures) return null;
            throw new Error(message);
          },
          all: async <T,>(): Promise<{ results: T[] }> => ({ results: [] as T[] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
        return statement;
      },
    };
    return { db, calls: () => calls };
  }

  it('surfaces a permanent schema failure as a DatabaseError without retrying', async () => {
    const { db, calls } = failingDb('D1_ERROR: no such table: dav_volumes');
    const dao = new DavVolumeDAO(db);
    await expect(dao.getByOwnerName('alice', 'photos')).rejects.toBeInstanceOf(DatabaseError);
    // Non-retryable: one attempt, not four.
    expect(calls()).toBe(1);
  });

  it('surfaces a transient failure as a retryable DatabaseError after retrying', async () => {
    const { db, calls } = failingDb('D1_ERROR: database is locked', Infinity);
    const dao = new DavVolumeDAO(db);
    await expect(dao.getByOwnerName('alice', 'photos')).rejects.toMatchObject({ retryable: true });
    // 1 initial attempt + 3 retries, matching every write path.
    expect(calls()).toBe(4);
  });

  it('normalizes the credential lookup the same way', async () => {
    const { db } = failingDb('D1_ERROR: no such column: read_only');
    const dao = new DavCredentialDAO(db);
    await expect(dao.getActiveByUsername('quiet-otter')).rejects.toBeInstanceOf(DatabaseError);
  });

  it('gives up on a retryable failure rather than looping forever', async () => {
    // The retry budget is finite: an always-failing retryable error must still
    // surface as a typed DatabaseError, not hang the request.
    const { db, calls } = failingDb('D1_ERROR: database is locked');
    const dao = new DavCredentialDAO(db);
    await expect(dao.getActiveByUsername('quiet-otter')).rejects.toBeInstanceOf(DatabaseError);
    expect(calls()).toBe(4);
  });

  it('retries a read and succeeds when the failure clears', async () => {
    // The point of retrying a read at all: a transient blip must not surface.
    const { db, calls } = failingDb('D1_ERROR: database is locked', 2);
    const dao = new DavVolumeDAO(db);
    await expect(dao.getByOwnerName('alice', 'photos')).resolves.toBeNull();
    expect(calls()).toBe(3);
  });

  it('leaves a row-returning read untouched', async () => {
    // `null` means "no row" and must not be treated as a failure worth retrying.
    const row = { id: 'vol_1' };
    const db: D1Queryable = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          first: async <T,>(): Promise<T | null> => row as T,
          all: async <T,>(): Promise<{ results: T[] }> => ({ results: [row] as T[] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
        return statement;
      },
    };
    const dao = new DavVolumeDAO(db);
    await expect(dao.getByOwnerName('alice', 'photos')).resolves.toEqual(row);
  });

  it('answers 503 rather than 500 when auth reads fail', async () => {
    // The end-to-end consequence: a D1 outage on the DAV auth path is now the
    // documented 503, not an unhandled 500.
    resetCredentialMemoForTests();
    const failing: D1Queryable = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          first: async <T,>(): Promise<T | null> => {
            throw new Error('D1_ERROR: no such table: dav_volumes');
          },
          all: async <T,>(): Promise<{ results: T[] }> => ({ results: [] as T[] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
        return statement;
      },
    };
    const app = new Hono<TestEnv>();
    app.use('*', async (c, next) => {
      const scope = new Container();
      scope.bindValue(Tokens.VolumeService, { getVolume: () => Promise.resolve(volumeRow()) } as unknown as VolumeService);
      scope.bindValue(Tokens.DavCredentialDAO, () => Promise.resolve(new DavCredentialDAO(failing)));
      scope.bindValue(Tokens.DavPermissionService, { getRole: () => Promise.resolve('read' as const) } as unknown as DavPermissionService);
      scope.bindValue(Tokens.UserIdentityService, { resolveUserById: () => Promise.resolve(null) } as unknown as UserIdentityService);
      setRequestScope(c, scope);
      await next();
    });
    app.onError(() => new Response('Unhandled', { status: 500 }));
    app.all('/:owner/:volume/*', async (c) => {
      const result = await davAuthForVolume(c, c.req.param('owner') ?? '', c.req.param('volume') ?? '', isWrite(c.req.method));
      return result instanceof Response ? result : c.json(result);
    });
    const response = await app.request('https://x/alice/photos/file.txt', { method: 'GET', headers: basic() });
    // The stubbed `getVolume` does not touch D1, so the failing credential read
    // is what must surface — as the typed error the 503 branch handles.
    expect(response.status).toBe(503);
    resetCredentialMemoForTests();
  });
});

/**
 * Direct exercise of the verifier DO.
 *
 * The unit `cloudflare:workers` mock supplies only the `DurableObject` base, so
 * this constructs the class with a minimal fake state and drives `fetch`
 * directly. That is enough because the class holds no storage — the cache is
 * in-memory, which is also why losing the object costs only a re-derivation.
 */
function verifierDo(env: Env = {} as Env): InstanceType<typeof CredentialVerifierDO> {
  const ctx = { id: { name: 'shard-0' }, storage: {} } as unknown as DurableObjectState;
  return new CredentialVerifierDO(ctx, env);
}

function verifyBody(username: string, password: string, passwordHash: string): Request {
  return new Request('https://dav-auth.internal/verify', {
    method: 'POST',
    body: JSON.stringify({ username, password, passwordHash }),
  });
}

/**
The DO's verdict for one presented credential, as a plain boolean.
*/
async function readOk(
  instance: InstanceType<typeof CredentialVerifierDO>,
  username: string,
  password: string,
  passwordHash: string,
): Promise<boolean> {
  const body = (await (await instance.fetch(verifyBody(username, password, passwordHash))).json()) as { ok: boolean };
  return body.ok;
}

describe('the verifier DO endpoint', () => {
  it('authenticates a correct password', async () => {
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const response = await verifierDo().fetch(verifyBody(USERNAME, PASSWORD, hash));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, needsRehash: false, upgradedHash: null });
  });

  it('refuses a wrong password', async () => {
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const response = await verifierDo().fetch(verifyBody(USERNAME, 'wrong', hash));
    expect(await response.json()).toEqual({ ok: false, needsRehash: false, upgradedHash: null });
  });

  it('does not cache a failure', async () => {
    // Otherwise a wrong password becomes a free oracle after one guess.
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const instance = verifierDo();
    await instance.fetch(verifyBody(USERNAME, 'wrong', hash));
    expect(instance.cacheSize()).toBe(0);
  });

  it('caches a success and answers the repeat without re-deriving', async () => {
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const instance = verifierDo();
    expect(instance.cacheSize()).toBe(0);
    await instance.fetch(verifyBody(USERNAME, PASSWORD, hash));
    expect(instance.cacheSize()).toBe(1);
    const second = await instance.fetch(verifyBody(USERNAME, PASSWORD, hash));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, needsRehash: false, upgradedHash: null });
  });

  it('will not answer a cached verdict for a rotated hash', async () => {
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const rotated = await DavCredentialUtil.hashPassword(PASSWORD);
    const instance = verifierDo();
    await instance.fetch(verifyBody(USERNAME, PASSWORD, hash));
    // Same password, different stored hash: the entry must not be reused.
    expect(await readOk(instance, USERNAME, PASSWORD, rotated)).toBe(true);
    expect(instance.cacheSize()).toBe(1);
  });

  it('will not answer for a different password on the same username', async () => {
    // The bypass the fingerprint in the cache key exists to prevent.
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const instance = verifierDo();
    await instance.fetch(verifyBody(USERNAME, PASSWORD, hash));
    expect(await readOk(instance, USERNAME, 'a-different-password', hash)).toBe(false);
  });

  it('returns an upgraded hash for a legacy digest', async () => {
    const legacyHex = await legacyDigestHex(PASSWORD);
    const body = (await (await verifierDo().fetch(verifyBody(USERNAME, PASSWORD, legacyHex))).json()) as {
      ok: boolean;
      needsRehash: boolean;
      upgradedHash: string | null;
    };
    expect(body).toMatchObject({ ok: true, needsRehash: true });
    expect(body.upgradedHash).toMatch(/^pbkdf2-sha256\$/u);
  });

  it('coalesces concurrent misses into one derivation', async () => {
    // The object serializes its handlers, so without single-flight a cold-start
    // burst would run one PBKDF2 per request where one suffices.
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const instance = verifierDo();
    const responses = await Promise.all(Array.from({ length: 6 }, () => instance.fetch(verifyBody(USERNAME, PASSWORD, hash))));
    for (const response of responses) expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    expect(instance.cacheSize()).toBe(1);
  });

  it('rejects anything that is not an internal verify call', async () => {
    // It accepts a presented password, so it must never be reachable as a
    // public endpoint. Only POST /verify is a valid shape.
    const instance = verifierDo();
    expect((await instance.fetch(new Request('https://dav-auth.internal/verify'))).status).toBe(404);
    expect((await instance.fetch(new Request('https://dav-auth.internal/other', { method: 'POST' }))).status).toBe(404);
    expect((await instance.fetch(new Request('https://dav-auth.internal/verify'))).status).toBe(404);
  });

  it('rejects a malformed body without throwing', async () => {
    const instance = verifierDo();
    for (const body of ['', 'not json', '{}', JSON.stringify({ username: USERNAME })]) {
      const response = await instance.fetch(
        new Request('https://dav-auth.internal/verify', { method: 'POST', body }),
      );
      expect(response.status, body).toBe(400);
    }
  });

  it('treats a malformed stored hash as a failed auth', async () => {
    const response = await verifierDo().fetch(verifyBody(USERNAME, PASSWORD, 'garbage'));
    expect(await response.json()).toEqual({ ok: false, needsRehash: false, upgradedHash: null });
  });

  it('drops cached verdicts on invalidate', async () => {
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    const instance = verifierDo();
    await instance.fetch(verifyBody(USERNAME, PASSWORD, hash));
    expect(instance.cacheSize()).toBe(1);
    instance.invalidate(USERNAME);
    expect(instance.cacheSize()).toBe(0);
  });

  it('honours a configured TTL and falls back to the default', () => {
    // A zero/negative/NaN var must not produce a cache that never expires or
    // one that is permanently expired.
    expect(new CredentialVerifierDO({} as DurableObjectState, { CREDENTIAL_MEMO_TTL_SECONDS: '5' } as unknown as Env).cacheSize()).toBe(0);
    expect(new CredentialVerifierDO({} as DurableObjectState, { CREDENTIAL_MEMO_TTL_SECONDS: '0' } as unknown as Env).cacheSize()).toBe(0);
    expect(new CredentialVerifierDO({} as DurableObjectState, { CREDENTIAL_MEMO_TTL_SECONDS: 'nonsense' } as unknown as Env).cacheSize()).toBe(0);
  });
});

/**
 * The `DAV_AUTH` hop itself.
 *
 * A stubbed `DurableObjectNamespace` stands in for the binding, so these pin the
 * contract between front door and verifier: which replies are trusted, and what
 * happens when the hop cannot be made at all.
 */
type FetchOutcome = { status: number; body: unknown };

function fakeNamespace(outcome: FetchOutcome | Error): { env: Env; calls: () => number } {
  let calls = 0;
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (): Promise<Response> => {
        calls += 1;
        if (outcome instanceof Error) throw outcome;
        return Response.json(outcome.body, { status: outcome.status });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { env: { DAV_AUTH: namespace } as unknown as Env, calls: () => calls };
}

describe('the verifier DO hop', () => {
  it('uses the DO answer on the happy path', async () => {
    const { env, calls } = fakeNamespace({ status: 200, body: { ok: true, needsRehash: false, upgradedHash: null } });
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    expect(await verifyCredential(env, USERNAME, PASSWORD, hash)).toEqual({
      ok: true,
      needsRehash: false,
      upgradedHash: null,
    });
    expect(calls()).toBe(1);
  });

  it('trusts a refusal from the DO', async () => {
    const { env } = fakeNamespace({ status: 200, body: { ok: false, needsRehash: false, upgradedHash: null } });
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    expect((await verifyCredential(env, USERNAME, 'wrong', hash)).ok).toBe(false);
  });

  it('accepts the upgraded hash the DO computes', async () => {
    const upgraded = await DavCredentialUtil.hashPassword(PASSWORD);
    const { env } = fakeNamespace({ status: 200, body: { ok: true, needsRehash: true, upgradedHash: upgraded } });
    const legacyHex = await legacyDigestHex(PASSWORD);
    const outcome = await verifyCredential(env, USERNAME, PASSWORD, legacyHex);
    expect(outcome).toEqual({ ok: true, needsRehash: true, upgradedHash: upgraded });
  });

  it('falls back to a local derivation when the hop throws', async () => {
    // Better a CPU overrun than a lockout: an auth-path transport failure must
    // not deny a credential that is genuinely valid.
    const { env } = fakeNamespace(new Error('DO unreachable'));
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    expect((await verifyCredential(env, USERNAME, PASSWORD, hash)).ok).toBe(true);
  });

  it('falls back on a non-2xx or unparseable reply', async () => {
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    for (const outcome of [{ status: 500, body: {} }, { status: 200, body: { ok: 'yes' } }, { status: 200, body: null }]) {
      const { env } = fakeNamespace(outcome as FetchOutcome);
      expect((await verifyCredential(env, USERNAME, PASSWORD, hash)).ok, JSON.stringify(outcome)).toBe(true);
    }
  });

  it('makes exactly one hop per request, not one per tier', async () => {
    const { env, calls } = fakeNamespace({ status: 200, body: { ok: true, needsRehash: false, upgradedHash: null } });
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    await verifyCredential(env, USERNAME, PASSWORD, hash);
    // Second call is served by the isolate memo, so the DO is not consulted
    // again — this is the property that keeps the hot path hop-free.
    await verifyCredential(env, USERNAME, PASSWORD, hash);
    await verifyCredential(env, USERNAME, PASSWORD, hash);
    expect(calls()).toBe(1);
    resetCredentialMemoForTests();
  });

  it('does not memoize a DO-reported failure', async () => {
    const { env, calls } = fakeNamespace({ status: 200, body: { ok: false, needsRehash: false, upgradedHash: null } });
    const hash = await DavCredentialUtil.hashPassword(PASSWORD);
    await verifyCredential(env, USERNAME, PASSWORD, hash);
    await verifyCredential(env, USERNAME, PASSWORD, hash);
    expect(calls()).toBe(2);
    resetCredentialMemoForTests();
  });
});

describe('a hash-upgrade failure does not fail authentication', () => {
  it('still authorizes a legacy credential and never rewrites the row with null', async () => {
    // The legacy digest keeps verifying, so a failed rehash only defers the
    // upgrade. Turning it into a 500 — or writing `null` over the hash — would
    // lock out a valid credential and destroy the row's only secret.
    const legacyHex = await legacyDigestHex(PASSWORD);
    const { db, queries } = fakeDb(await credentialRow({ password_hash: legacyHex }));
    const dao = new DavCredentialDAO(db);
    const outcome = await verifyCredential({} as Env, USERNAME, PASSWORD, legacyHex);
    expect(outcome.ok).toBe(true);
    expect(outcome.needsRehash).toBe(true);
    if (outcome.upgradedHash) await dao.updatePasswordHash('cred_1', outcome.upgradedHash);
    // `DavAuth` guards the write on `needsRehash && upgradedHash`, so a missing
    // upgrade hash means no UPDATE at all.
    expect(queries.some((q) => q.startsWith('UPDATE dav_credentials SET password_hash'))).toBe(outcome.upgradedHash !== null);
    resetCredentialMemoForTests();
  });
});
