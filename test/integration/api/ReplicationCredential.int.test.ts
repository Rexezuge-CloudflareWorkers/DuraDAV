import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';
import { decryptReplicationSecret } from '../../../packages/backend-data/src/crypto/aes-gcm';

/**
 * The stored credential, through the real HTTP route and the real D1 row.
 *
 * The unit suite (`test/replication-credential.test.ts`) drives the service against a
 * fake DAO, and the runner suite drives the reader against a hand-built envelope.
 * Neither touches the thing that actually broke: the seam between the route, the
 * service, and the `encrypted_secret` column. This file crosses it — POST a
 * replication with `authKind: 'basic'`, read the row back out of D1, and decrypt it
 * with the same key the Worker used.
 *
 * That assertion is the whole point. `basic` replication shipped 100% broken because
 * `createReplication` validated a username and then sealed the bare password without
 * it; every existing test passed, because every one of them supplied the envelope
 * themselves and so never noticed the writer was not producing the format the reader
 * expected. A test that only ever hands the reader a correct blob cannot catch a
 * writer that emits a wrong one.
 *
 * ## Why no sync is driven here
 *
 * A `dav` target's sync would make real HTTPS egress to a host the SSRF policy
 * refuses, so asserting on the *stored* credential is both the reachable half and the
 * half that was wrong. The read side is covered in `test/replication-runner.test.ts`,
 * which feeds a sealed `user:password` through the real `buildRemote` and decodes the
 * `Authorization` header back out.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

// Must match `DEV_AUTH_EMAIL` in `wrangler.test.jsonc`.
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Must match `REPLICATION_ENCRYPTION_KEY` in `wrangler.test.jsonc`.
const KEY = '4TvmnrKMuQV1Yt2yFGbjaOgN5TDqF48yMxhuwJ7q63k=';

let OWNER = 'credowner';
const VOLUME = 'credvolume';

/**
 * `https://dav.example.com/...` — a public-shaped host that never resolves in a
 * test, and is never contacted: these cases stop at the stored row.
 *
 * Per-case, because `(target_kind, remote_url, remote_owner, remote_volume,
 * remote_path)` is unique per volume: two cases sharing a URL collide on the index
 * and the second create answers 400 "already configured" — a real constraint, but one
 * that would mask what each case is actually asserting.
 */
const remoteUrlFor = (label: string): string => `https://dav.example.com/dav/files/alice/${label}`;

const api = (path: string, init: RequestInit = {}): Promise<Response> => SELF.fetch(`https://example.com${path}`, init);

async function storedSecret(replicationId: string): Promise<string | null> {
  // The `TestEnv` cast is the suite-wide idiom: `cloudflare:test`'s `env` is typed
  // as the generated worker env, whose `DB` binding is not a generic `D1Database`.
  const db = (env as unknown as TestEnv).DB;
  const row = await db
    .prepare('SELECT encrypted_secret, secret_iv FROM dav_replications WHERE replication_id = ?')
    .bind(replicationId)
    .first<{ encrypted_secret: string | null; secret_iv: string | null }>();
  return row === null || row.encrypted_secret === null || row.secret_iv === null ? null : decryptReplicationSecret({ ciphertext: row.encrypted_secret, iv: row.secret_iv }, KEY);
}

async function createBasic(input: { label: string; username?: string; secret?: string }): Promise<Response> {
  return api(`/user/volumes/${OWNER}/${VOLUME}/replications`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      targetKind: 'dav',
      remoteUrl: remoteUrlFor(input.label),
      authKind: 'basic',
      username: input.username,
      secret: input.secret,
      mode: 'keep-both',
      intervalMinutes: 360,
    }),
  });
}

async function replicationIdFrom(res: Response): Promise<string> {
  const body = (await res.json()) as { replication: { replicationId: string } };
  return body.replication.replicationId;
}

describe('a basic replication credential, through the API', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, EMAIL);
    // The handle has to be *claimed*, not assumed: `/user/volumes` is owner-only
    // against the caller's own username, and `ensureUser` is what puts one there.
    await ensureUser(testEnv.DB, EMAIL, OWNER);
    const row = await testEnv.DB.prepare('SELECT username FROM users WHERE email = ?').bind(EMAIL).first<{ username: string | null }>();
    OWNER = row?.username ?? OWNER;
    const volume = await api('/user/volumes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ owner: OWNER, name: VOLUME }) });
    expect(volume.status).toBe(201);
  });

  it('stores the username with the password', async () => {
    // The bug, stated as an assertion. A build that drops the username stores
    // `hunter2`, and every subsequent sync fails with an unreadable-credential error
    // that its own "rotate it" advice cannot clear.
    const res = await createBasic({ label: 'alice', username: 'alice', secret: 'hunter2' });
    expect(res.status).toBe(201);
    const replicationId = await replicationIdFrom(res);
    expect(await storedSecret(replicationId)).toBe('alice:hunter2');
  });

  it('never leaves the secret readable in the response', async () => {
    // The projection is the only thing between a stored credential and a client, and
    // this is the assertion that it stays that way now that the blob carries a
    // username too.
    const res = await createBasic({ label: 'bob', username: 'bob', secret: 's3cret' });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('encrypted_secret');
    expect(text).not.toContain('secret_iv');
    const replicationId = (JSON.parse(text) as { replication: { replicationId: string } }).replication.replicationId;
    await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}`, { method: 'DELETE' });
  });

  it('rotates into a credential the reader can use', async () => {
    const created = await createBasic({ label: 'carol', username: 'carol', secret: 'first-password' });
    const replicationId = await replicationIdFrom(created);
    expect(await storedSecret(replicationId)).toBe('carol:first-password');

    const rotated = await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}/credential`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ authKind: 'basic', username: 'carol', secret: 'second-password' }),
    });
    expect(rotated.status).toBe(200);
    expect(await storedSecret(replicationId)).toBe('carol:second-password');
    await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}`, { method: 'DELETE' });
  });

  it('refuses a password-only rotation instead of storing an unusable credential', async () => {
    // The response is a 400 naming the field, not a 200 that leaves the target just
    // as broken as before while reporting success.
    const created = await createBasic({ label: 'dave', username: 'dave', secret: 'pw' });
    const replicationId = await replicationIdFrom(created);
    const rotated = await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}/credential`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ secret: 'new-pw' }),
    });
    expect(rotated.status).toBe(400);
    expect(await rotated.text()).toMatch(/username/);
    await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}`, { method: 'DELETE' });
  });

  it('refuses a create with no username, and one with a colon in it', async () => {
    expect((await createBasic({ label: 'nouser', secret: 'pw' })).status).toBe(400);
    // RFC 7617 forbids a colon in a user-id. Refused here rather than stored and
    // discovered at sync time, where it would read as a target fault.
    const colon = await createBasic({ label: 'colonuser', username: 'ali:ce', secret: 'pw' });
    expect(colon.status).toBe(400);
    expect(await colon.text()).toMatch(/username must not contain/);
  });

  it('keeps a password containing a colon intact', async () => {
    // Splitting on the *first* colon is the rule, so this round-trips. A reader that
    // split on the last one would silently send the wrong password.
    const res = await createBasic({ label: 'erin', username: 'erin', secret: 'pa:ss:word' });
    expect(res.status).toBe(201);
    const replicationId = await replicationIdFrom(res);
    expect(await storedSecret(replicationId)).toBe('erin:pa:ss:word');
    await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}`, { method: 'DELETE' });
  });

  it('does not trim a password with significant whitespace', async () => {
    // RFC 7617 puts everything after the first colon into the password verbatim, so
    // a trimmed one is a different credential and authenticates as a 401.
    const res = await createBasic({ label: 'frank', username: 'frank', secret: '  spaced  ' });
    expect(res.status).toBe(201);
    const replicationId = await replicationIdFrom(res);
    expect(await storedSecret(replicationId)).toBe('frank:  spaced  ');
    await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}`, { method: 'DELETE' });
  });

  it('stores a bearer token without a username prefix', async () => {
    // `authKind: 'bearer'` has one half; prefixing it would corrupt the token.
    const res = await api(`/user/volumes/${OWNER}/${VOLUME}/replications`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        targetKind: 'dav',
        remoteUrl: remoteUrlFor('bearer'),
        authKind: 'bearer',
        username: 'ignored',
        secret: 'tok-abc',
        mode: 'keep-both',
        intervalMinutes: 360,
      }),
    });
    expect(res.status).toBe(201);
    const replicationId = await replicationIdFrom(res);
    expect(await storedSecret(replicationId)).toBe('tok-abc');
    await api(`/user/volumes/${OWNER}/${VOLUME}/replications/${replicationId}`, { method: 'DELETE' });
  });
});