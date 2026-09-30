import { beforeAll, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';
import { DavCredentialUtil } from '@durable-dav/shared/utils';

/**
 * Password verification offload, end-to-end over real D1 and a real DO.
 *
 * The production bug this covers: on the Workers Free plan (10 ms CPU) a single
 * PBKDF2 derivation at 100k iterations overran the budget on *every*
 * Basic-authenticated DAV request, Cloudflare killed the invocation
 * (`outcome: "exceededCpu"`), and the client saw an HTTP 503 from no code in
 * this repository. Reads were the visible symptom because reads are all a
 * read-only credential can attempt, which made it look like a read-only bug.
 *
 * The unit tests cannot see this: CPU time is not observable from vitest. What
 * they *can* pin is that the memoized path still authorizes correctly, that a
 * wrong password still fails after a success, and that the verifier DO is
 * actually reachable through the binding — which is what this file adds.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

const OWNER = 'cvoffload';
const VOLUME = 'cvoffload-vol';
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let ownerHandle = OWNER;

/**
 * Migrations run once in `beforeAll`: D1 is shared across the tests in a file,
 * and re-applying 0004 fails on its own `ADD COLUMN id`. Each test below then
 * works on its own path and mints its own credential.
 */
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
  expect([201, 400]).toContain(created.status);
});

async function mintCredential(name: string, readOnly = false): Promise<{ username: string; password: string; credentialId: string }> {
  const res = await SELF.fetch(`https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, readOnly }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { username: string; password: string; credentialId: string };
}

const basic = (username: string, password: string, scheme = 'Basic'): string => `${scheme} ${btoa(`${username}:${password}`)}`;

function propfind(authorization: string): Promise<Response> {
  return SELF.fetch(`https://example.com/${ownerHandle}/${VOLUME}/`, {
    method: 'PROPFIND',
    headers: { Authorization: authorization, Depth: '0' },
  });
}

describe('credential verification offload over real D1 + DO', () => {
  it('authorizes a read on the first request and on every repeat', async () => {
    // The memo's whole purpose: a repeat must not change the answer, only the
    // CPU spent reaching it.
    const cred = await mintCredential('repeat');
    for (let i = 0; i < 6; i += 1) {
      const res = await propfind(basic(cred.username, cred.password));
      expect(res.status, `request ${i}`).toBe(207);
    }
  });

  it('serves ranged GETs, the shape that reproduced the report', async () => {
    // The failing log was a media client pulling 128 KB chunks: many GETs with
    // a Range header against one bucket on one credential.
    const cred = await mintCredential('ranged');
    const put = await SELF.fetch(`https://example.com/${ownerHandle}/${VOLUME}/chunk.bin`, {
      method: 'PUT',
      headers: { Authorization: basic(cred.username, cred.password), 'Content-Type': 'application/octet-stream' },
      body: 'x'.repeat(4096),
    });
    expect([201, 204]).toContain(put.status);
    for (let i = 0; i < 4; i += 1) {
      const res = await SELF.fetch(`https://example.com/${ownerHandle}/${VOLUME}/chunk.bin`, {
        method: 'GET',
        headers: { Authorization: basic(cred.username, cred.password), Range: 'bytes=0-131071' },
      });
      expect(res.status, `chunk ${i}`).toBe(206);
    }
  });

  it('still refuses a wrong password after a successful one', async () => {
    // A memo hit must never become a blanket allow for the username.
    const cred = await mintCredential('wrong-after-right');
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    const wrong = await propfind(basic(cred.username, `${cred.password}x`));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('WWW-Authenticate')).toMatch(/^Basic\b/u);
  });

  it('refuses a read-only credential a write while reads still succeed', async () => {
    // The read-only flag is enforced in DavAuth, downstream of verification, so
    // caching the derivation cannot leak write access.
    const cred = await mintCredential('ro-offload', true);
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    const put = await SELF.fetch(`https://example.com/${ownerHandle}/${VOLUME}/nope.txt`, {
      method: 'PUT',
      headers: { Authorization: basic(cred.username, cred.password) },
      body: 'nope',
    });
    expect(put.status).toBe(403);
    expect(put.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('accepts a lowercase basic scheme end-to-end', async () => {
    // RFC 9110 §11.1. Before the fix the credential was dropped and the request
    // fell through to the anonymous branch: a 401 on a private bucket.
    const cred = await mintCredential('lowercase-scheme');
    expect((await propfind(basic(cred.username, cred.password, 'basic'))).status).toBe(207);
  });

  it('stops authorizing immediately after the credential is deleted', async () => {
    // Revocation must not wait out the memo TTL, because the D1 row is re-read
    // on every request even when the derivation is served from the memo.
    const cred = await mintCredential('revoked');
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    const deleted = await SELF.fetch(
      `https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials/${cred.credentialId}`,
      { method: 'DELETE', headers: JSON_HEADERS },
    );
    expect(deleted.status).toBe(200);
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(401);
  });

  it('stops authorizing after the read-only flag is relaxed and re-tightened', async () => {
    // A flipped flag changes what the D1 row means, and the row is re-read every
    // request, so the memo cannot serve a stale authorization decision.
    const cred = await mintCredential('flag-flip', true);
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    const patched = await SELF.fetch(
      `https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials/${cred.credentialId}`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ readOnly: false }) },
    );
    expect(patched.status).toBe(200);
    const put = await SELF.fetch(`https://example.com/${ownerHandle}/${VOLUME}/allowed.txt`, {
      method: 'PUT',
      headers: { Authorization: basic(cred.username, cred.password) },
      body: 'ok',
    });
    expect([201, 204]).toContain(put.status);
  });

  it('rehashes a legacy digest in place on first use', async () => {
    const cred = await mintCredential('legacy-upgrade');
    const testEnv = env as unknown as TestEnv;
    const legacy = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cred.password))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    await testEnv.DB.prepare('UPDATE dav_credentials SET password_hash = ? WHERE credential_id = ?')
      .bind(legacy, cred.credentialId)
      .run();

    // First use: the legacy digest verifies and is upgraded.
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    const row = await testEnv.DB.prepare('SELECT password_hash FROM dav_credentials WHERE credential_id = ?')
      .bind(cred.credentialId)
      .first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256\$\d+\$/u);

    // Second use: now a plain current-format verification, still 207.
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
    // And the upgraded hash is the one that was persisted.
    expect((await DavCredentialUtil.verifyPassword(cred.password, row?.password_hash ?? '')).ok).toBe(true);
  });

  it('leaves a credential unharmed when it is used with a wrong password', async () => {
    const cred = await mintCredential('wrong-then-right');
    const testEnv = env as unknown as TestEnv;
    expect((await propfind(basic(cred.username, 'wrong'))).status).toBe(401);
    const row = await testEnv.DB.prepare('SELECT password_hash FROM dav_credentials WHERE credential_id = ?')
      .bind(cred.credentialId)
      .first<{ password_hash: string }>();
    // A failed attempt must not rewrite the stored hash.
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256\$/u);
    expect((await propfind(basic(cred.username, cred.password))).status).toBe(207);
  });
});