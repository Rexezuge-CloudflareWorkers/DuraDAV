import { beforeAll, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser, seedVolume } from '../helpers/setup';

/**
 * Read-only bucket credentials over the real worker.
 *
 * The flag is chosen at creation and can be flipped afterwards, so what matters
 * here is the *pair*: the same bucket, the same owner, one credential that may
 * write and one that may not. Asserting only the refusal would pass just as
 * well against a bucket that rejected every write, and asserting only the
 * success would pass against a flag wired to nothing.
 *
 * The browser plane is deliberately out of scope: uploads there run under
 * Cloudflare Access as the owner, not under a bucket credential, so this flag
 * restricts WebDAV clients and nothing else.
 *
 * D1 is shared across the tests in a file, so the migrations run once in
 * `beforeAll` (re-applying 0004 fails on its own `ADD COLUMN`) and each test
 * works on its own path and its own credentials.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

const OWNER = 'roowner';
const VOLUME = 'ro-vol';
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let ownerHandle = OWNER;

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await setupIntegrationTest(testEnv, EMAIL);
  await ensureUser(testEnv.DB, EMAIL, OWNER);
  const row = await testEnv.DB.prepare('SELECT username FROM users WHERE email = ?').bind(EMAIL).first<{ username: string | null }>();
  ownerHandle = row?.username ?? OWNER;
  const created = await SELF.fetch('https://example.com/user/volumes', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ owner: ownerHandle, name: VOLUME }),
  });
  // Idempotent across re-runs: 400 means it already exists.
  expect([201, 400]).toContain(created.status);
});

async function mintCredential(name: string, readOnly?: boolean): Promise<{ username: string; password: string; credentialId: string; readOnly: boolean }> {
  const res = await SELF.fetch(`https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(readOnly === undefined ? { name } : { name, readOnly }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { username: string; password: string; credentialId: string; readOnly: boolean };
}

function setReadOnly(credentialId: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials/${credentialId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

const basic = (username: string, password: string): string => `Basic ${btoa(`${username}:${password}`)}`;

function dav(
  method: string,
  cred: { username: string; password: string },
  options: { path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return SELF.fetch(`https://example.com/${ownerHandle}/${VOLUME}/${options.path ?? 'notes.txt'}`, {
    method,
    headers: { Authorization: basic(cred.username, cred.password), ...options.headers },
    body: options.body,
  });
}

describe('read-only credentials over the real DAV plane', () => {
  it('lets a read-only credential read and refuses its write', async () => {
    const readonly = await mintCredential('ro-read', true);
    expect(readonly.readOnly).toBe(true);

    const put = await dav('PUT', readonly, { path: 'denied.txt', body: 'hello' });
    expect(put.status).toBe(403);
    expect(put.headers.get('WWW-Authenticate')).toBeNull();
    expect(await put.text()).toContain('cannot-modify-protected-property');

    // The refusal must not have written anything: the same read a full-access
    // credential would satisfy reports the file as absent.
    const missing = await dav('PROPFIND', readonly, { path: 'denied.txt', headers: { Depth: '0' } });
    expect(missing.status).toBe(404);
  });

  it('leaves a full-access credential on the same bucket able to write', async () => {
    const readonly = await mintCredential('ro-paired-read', true);
    const full = await mintCredential('ro-paired-full');

    expect((await dav('PUT', readonly, { path: 'paired.txt', body: 'nope' })).status).toBe(403);
    expect([201, 204]).toContain((await dav('PUT', full, { path: 'paired.txt', body: 'yes' })).status);

    // And the read-only credential can now see the file the other one wrote.
    const get = await dav('GET', readonly, { path: 'paired.txt' });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('yes');
  });

  it('refuses every write method, not just PUT', async () => {
    const readonly = await mintCredential('ro-methods', true);
    for (const method of ['PUT', 'DELETE', 'MKCOL', 'LOCK', 'PROPPATCH']) {
      const res = await dav(method, readonly, {
        path: 'methods.txt',
        body: 'x',
        headers: method === 'LOCK' ? { Timeout: 'Second-60' } : {},
      });
      expect(res.status, `${method} must be refused`).toBe(403);
    }
  });

  it('refuses a copy and a move that would land inside the volume', async () => {
    // Both write content, so neither may slip past on a destination argument.
    const readonly = await mintCredential('ro-copy', true);
    for (const method of ['COPY', 'MOVE']) {
      const res = await dav(method, readonly, {
        path: 'copymove.txt',
        headers: { Destination: `https://example.com/${ownerHandle}/${VOLUME}/target.txt` },
      });
      expect(res.status, `${method} must be refused`).toBe(403);
    }
  });

  it('applies a flip to the next request without a new password', async () => {
    const cred = await mintCredential('ro-flip');
    expect([201, 204]).toContain((await dav('PUT', cred, { path: 'flip.txt', body: 'before' })).status);

    const flipped = await setReadOnly(cred.credentialId, { readOnly: true });
    expect(flipped.status).toBe(200);
    expect(await flipped.json()).toMatchObject({ credentialId: cred.credentialId, readOnly: true });
    expect((await dav('PUT', cred, { path: 'flip.txt', body: 'after' })).status).toBe(403);

    // And back again, with the same credential: a flag that could only be set
    // at creation would leave the owner holding a dead credential.
    expect((await setReadOnly(cred.credentialId, { readOnly: false })).status).toBe(200);
    expect([201, 204]).toContain((await dav('PUT', cred, { path: 'flip.txt', body: 'restored' })).status);
  });

  it('lists the flag so the settings tab can render it', async () => {
    const readonly = await mintCredential('ro-list-true', true);
    const full = await mintCredential('ro-list-false');
    const res = await SELF.fetch(`https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Array<{ credentialId: string; readOnly: boolean }> };
    const flags = new Map(body.credentials.map((c) => [c.credentialId, c.readOnly]));
    expect(flags.get(readonly.credentialId)).toBe(true);
    expect(flags.get(full.credentialId)).toBe(false);
  });

  it('rejects a non-boolean flag instead of quietly granting writes', async () => {
    for (const bad of ['true', 1, 'yes']) {
      const res = await SELF.fetch(`https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: `ro-bad-${String(bad)}`, readOnly: bad }),
      });
      expect(res.status, `readOnly: ${JSON.stringify(bad)} must be a 400`).toBe(400);
    }
    const cred = await mintCredential('ro-bad-patch');
    expect((await setReadOnly(cred.credentialId, { readOnly: 'true' })).status).toBe(400);
    // Rejected, so the credential is still a working write credential.
    expect([201, 204]).toContain((await dav('PUT', cred, { path: 'badflag.txt', body: 'x' })).status);
  });

  it('404s a flip against a credential that is not in the bucket', async () => {
    // Reporting success for a credential that does not exist is how a caller
    // concludes the restriction was applied when nothing changed.
    expect((await setReadOnly('cred-does-not-exist', { readOnly: true })).status).toBe(404);
  });

  it('404s a flip against a bucket that does not exist', async () => {
    const res = await SELF.fetch('https://example.com/user/volumes/nosuchowner/nosuchvol/credentials/cred-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ readOnly: true }),
    });
    expect(res.status).toBe(404);
  });

  it('does not let a non-owner flip a credential on someone else\'s bucket', async () => {
    // The credential plane answers 403 rather than 404: this is the owner's own
    // management surface, so hiding existence buys nothing. The caller is fixed
    // by `DEV_AUTH_EMAIL` in the test env, so the foreign bucket is the part
    // that can be arranged.
    const testEnv = env as unknown as TestEnv;
    await ensureUser(testEnv.DB, 'stranger@example.com', 'stranger');
    await seedVolume(testEnv.DB, { ownerEmail: 'stranger@example.com', owner: 'stranger', name: 'theirs' });

    const res = await SELF.fetch('https://example.com/user/volumes/stranger/theirs/credentials/cred-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ readOnly: true }),
    });
    expect(res.status).toBe(403);
  });
});
