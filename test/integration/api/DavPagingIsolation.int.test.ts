import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';
import { parseMultistatus } from '../../../apps/web/src/lib/davXml';

/**
 * Paging isolation between the two front-door planes, over the real worker.
 *
 * RFC 4918 §9.1 has no paging concept, so a `Depth: 1` PROPFIND on the WebDAV
 * plane must return *every* member. The DO pages when it sees `X-Dav-Page*`, so
 * the front door is the enforcement point: `applyDavForwardHeaders` deletes both
 * headers and only re-adds them when the browser plane opts in.
 *
 * The bug this locks down: only the browser plane deleted them. On the WebDAV
 * plane a client-supplied pair survived to the DO, which truncated the
 * multistatus — and because `DavReadCache`'s PROPFIND key carries no page term,
 * that truncated body was then served to every *later unpaged* PROPFIND on the
 * same path for the entry's TTL. So the second assertion below (an unpaged
 * request after a paged one) is the one that matters: it is the cache-poisoning
 * leg, and a fix that only stripped the header without touching the cache would
 * still fail it.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

const EMAIL = 'test@example.com';
const VOLUME = 'paging';
const ENTRY_COUNT = 6;
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>';

let ownerHandle = 'paginguser';
let credential: { username: string; password: string };

const basic = (username: string, password: string): string => `Basic ${btoa(`${username}:${password}`)}`;

const dav = (innerPath = ''): string => `https://example.com/${ownerHandle}/${VOLUME}${innerPath === '' ? '/' : `/${innerPath}`}`;

async function propfind(path: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(path, {
    method: 'PROPFIND',
    headers: { Authorization: basic(credential.username, credential.password), 'Content-Type': 'application/xml; charset=utf-8', ...headers },
    body: PROPFIND_BODY,
  });
}

/**
 * Entry paths in a 207 body, via the real SPA parser.
 *
 * Reusing `parseMultistatus` rather than a hand-rolled regex means the count
 * below is the count a real client would see, and the parser strips the volume
 * base and the self-response for us.
 */
function entryPaths(xml: string): string[] {
  return parseMultistatus(xml, '', `/${ownerHandle}/${VOLUME}`).map((e) => e.path).sort();
}

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await setupIntegrationTest(testEnv, EMAIL);
  await ensureUser(testEnv.DB, EMAIL, 'paginguser');
  const row = await testEnv.DB.prepare('SELECT username FROM users WHERE email = ?').bind(EMAIL).first<{ username: string | null }>();
  ownerHandle = row?.username ?? 'paginguser';

  await SELF.fetch('https://example.com/user/volumes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: ownerHandle, name: VOLUME }),
  });

  const minted = await SELF.fetch(`https://example.com/user/volumes/${ownerHandle}/${VOLUME}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'paging-probe' }),
  });
  credential = (await minted.json()) as { username: string; password: string };

  for (let i = 0; i < ENTRY_COUNT; i++) {
    const put = await SELF.fetch(dav(`file-${i}.txt`), {
      method: 'PUT',
      headers: { Authorization: basic(credential.username, credential.password), 'Content-Type': 'text/plain' },
      body: `entry ${i}`,
    });
    expect(put.status, `PUT file-${i}.txt`).toBe(201);
  }
});

describe('the WebDAV plane never pages, whatever the client sets', () => {
  it('ignores a caller-supplied X-Dav-Page on Depth: 1', async () => {
    const res = await propfind(dav(), { Depth: '1', 'X-Dav-Page': '2', 'X-Dav-Page-Limit': '2' });
    expect(res.status).toBe(207);
    // The presence marker a client reads to decide whether the server pages.
    expect(res.headers.get('X-Dav-Page-Count')).toBeNull();
    expect(entryPaths(await res.text())).toHaveLength(ENTRY_COUNT);
  });

  it('ignores a caller-supplied X-Dav-Page-Limit alone', async () => {
    const res = await propfind(dav(), { Depth: '1', 'X-Dav-Page-Limit': '1' });
    expect(res.status).toBe(207);
    expect(res.headers.get('X-Dav-Page-Count')).toBeNull();
    expect(entryPaths(await res.text())).toHaveLength(ENTRY_COUNT);
  });

  it('does not let a paged request poison the cache for the next unpaged one', async () => {
    // The cache-poisoning leg. A paged request used to write a truncated 207
    // under a key with no page term, so this unpaged request — which never asked
    // for paging — would be served the truncated body for the entry's TTL.
    const paged = await propfind(dav(), { Depth: '1', 'X-Dav-Page': '1', 'X-Dav-Page-Limit': '2' });
    expect(paged.status).toBe(207);

    const unpaged = await propfind(dav(), { Depth: '1' });
    expect(unpaged.status).toBe(207);
    expect(unpaged.headers.get('X-Dav-Page-Count')).toBeNull();
    expect(entryPaths(await unpaged.text())).toHaveLength(ENTRY_COUNT);
  });

  it('still serves a Depth: 0 PROPFIND as a single self-response', async () => {
    const res = await propfind(dav(), { Depth: '0', 'X-Dav-Page': '1', 'X-Dav-Page-Limit': '1' });
    expect(res.status).toBe(207);
    expect(res.headers.get('X-Dav-Page-Count')).toBeNull();
  });
});
