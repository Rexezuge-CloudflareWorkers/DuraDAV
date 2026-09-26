import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';
import { parseMultistatus } from '../../../apps/web/src/lib/davXml';

/**
 * Per-bucket `DAV:href` prefix mode.
 *
 * RFC 4918 §8.3 requires every `DAV:href` to resolve against the request URL,
 * so the server emits `/owner/volume/dir/file.txt`. A minority of clients
 * instead expect the volume root at `/` and 404 on every entry otherwise; they
 * cannot be argued out of it, so `href_prefix_mode` lets a bucket opt out. This
 * suite pins both halves of that contract.
 *
 * The property that matters is not "the string changed" but "the server still
 * agrees with itself": a `root`-mode bucket hands out root-anchored hrefs, then
 * has to *accept* those same hrefs back as `Destination` and keep its own
 * request addressing on the real base. A change to the emitted shape that broke
 * either half would leave a client that can list a directory and then not open,
 * move, or copy anything in it — so every case pairs the assertion with a
 * follow-up request built from the value the server actually emitted.
 *
 * Fixtures are per-test and uniquely named. An earlier version shared one file
 * across cases, and a case that MOVEd it made three later ones fail on a name
 * that no longer existed — the suite then reported an addressing bug for what
 * was test-order coupling.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

const VOLUME = 'hrefmode';
// Must match `DEV_AUTH_EMAIL` in `wrangler.test.jsonc`.
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

/**
 * Resolved in `beforeAll`: `ensureUser` writes the username with `COALESCE`, so
 * a row seeded by an earlier suite keeps its original handle.
 */
let OWNER = 'hrefowner';
let DAV_BASE = `/${OWNER}/${VOLUME}`;
let auth: Record<string, string>;

const api = (path: string, init: RequestInit = {}): Promise<Response> => SELF.fetch(`https://example.com${path}`, init);

/**
 * WebDAV-plane request, credential-authenticated.
 */
const dav = (innerPath: string, init: RequestInit = {}): Promise<Response> =>
  api(`${DAV_BASE}${innerPath}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });

async function setMode(mode: 'base' | 'root'): Promise<void> {
  const res = await api(`/user/volumes/${OWNER}/${VOLUME}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ hrefPrefixMode: mode }),
  });
  expect(res.status, `PATCH hrefPrefixMode=${mode}`).toBe(200);
  expect(((await res.json()) as { hrefPrefixMode: string }).hrefPrefixMode).toBe(mode);
}

/**
 * Every `<href>` in a `Depth: 1` PROPFIND, percent-decoded.
 */
async function hrefsOf(innerPath: string): Promise<string[]> {
  const res = await dav(`/${innerPath}`, { method: 'PROPFIND', headers: { Depth: '1', ...XML_HEADERS }, body: PROPFIND_BODY });
  expect(res.status, `PROPFIND /${innerPath}`).toBe(207);
  return [...(await res.text()).matchAll(/<href>([^<]*)<\/href>/g)].map((m) => decodeURIComponent(m[1] ?? ''));
}

/**
 * A file no other test touches, named after `label` so a failure names its
 * owner.
 */
async function putFile(label: string, body = 'payload'): Promise<string> {
  const inner = `t-${label}.txt`;
  const res = await dav(`/${inner}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
  expect(res.status, `PUT /${inner}`).toBe(201);
  return inner;
}

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await setupIntegrationTest(testEnv, EMAIL);
  await ensureUser(testEnv.DB, EMAIL, OWNER);
  const row = await testEnv.DB.prepare(`SELECT username FROM users WHERE email = ?`).bind(EMAIL).first<{ username: string | null }>();
  OWNER = row?.username ?? OWNER;
  DAV_BASE = `/${OWNER}/${VOLUME}`;
  expect(OWNER).not.toBe('');

  const created = await api('/user/volumes', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ owner: OWNER, name: VOLUME }),
  });
  expect(created.status).toBe(201);
  // A freshly created bucket must be conforming without the owner asking.
  expect(((await created.json()) as { hrefPrefixMode: string }).hrefPrefixMode).toBe('base');

  const cred = await api(`/user/volumes/${OWNER}/${VOLUME}/credentials`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'hrefmode' }),
  });
  expect(cred.status).toBe(201);
  const { username, password } = (await cred.json()) as { username: string; password: string };
  auth = { Authorization: `Basic ${btoa(`${username}:${password}`)}` };

  expect((await dav('/docs', { method: 'MKCOL' })).status).toBe(201);
  expect((await dav('/sub', { method: 'MKCOL' })).status).toBe(201);
});

/**
 * Every case starts from the default so a failure names the mode under test
 * rather than inheriting the previous case's setting.
 */
beforeEach(async () => {
  await setMode('base');
});

describe('href prefix mode: default is the RFC-conforming base', () => {
  it('anchors hrefs at /owner/volume on a bucket that never opted out', async () => {
    const file = await putFile('default-shape');
    const root = await hrefsOf('');
    expect(root).toContain(`${DAV_BASE}/`);
    expect(root).toContain(`${DAV_BASE}/${file}`);
    expect(root).toContain(`${DAV_BASE}/docs/`);
    expect(root).toContain(`${DAV_BASE}/sub/`);
    // A nested listing carries the base on every entry too, and the *listed*
    // collection's own href is present — dropping that one is the SPA's job,
    // not the server's.
    expect(await hrefsOf('docs')).toEqual([`${DAV_BASE}/docs/`]);
    expect(root.some((h) => h === `/${file}` || h === '/sub/')).toBe(false);
  });

  it('accepts a base-prefixed Destination', async () => {
    const file = await putFile('base-dest');
    const res = await dav(`/${file}`, {
      method: 'MOVE',
      headers: { Destination: `https://example.com${DAV_BASE}/moved-${file}`, Overwrite: 'T' },
    });
    expect([200, 201, 204]).toContain(res.status);
    expect(await hrefsOf('')).toContain(`${DAV_BASE}/moved-${file}`);
  });

  it('refuses a root-anchored Destination, so nothing can be written outside the volume', async () => {
    // The rejection the DO's `stripBase` performs, now performed by the front
    // door before the request is forwarded. Without it a client could aim a
    // MOVE at `/moved-x.txt`, which names nothing in this bucket.
    const file = await putFile('base-refuse');
    const res = await dav(`/${file}`, {
      method: 'MOVE',
      headers: { Destination: 'https://example.com/moved-outside.txt', Overwrite: 'T' },
    });
    expect(res.status).toBe(400);
    expect(await hrefsOf('')).toContain(`${DAV_BASE}/${file}`);
  });
});

describe('href prefix mode: root', () => {
  it('anchors hrefs at / and takes effect on the very next request', async () => {
    // Immediately, not after the PROPFIND cache TTL. The cache key is
    // volume+path+depth+body with no term for the mode, so a flip that did not
    // purge would keep serving the old shape for up to two minutes — and the
    // control would look broken to the owner who just used it.
    const file = await putFile('root-shape');
    await setMode('root');
    const root = await hrefsOf('');
    expect(root).toContain('/');
    expect(root).toContain('/docs/');
    expect(root).toContain('/sub/');
    expect(root).toContain(`/${file}`);
    expect(root.some((h) => h.startsWith(DAV_BASE))).toBe(false);
    expect(await hrefsOf('docs')).toEqual(['/docs/']);
  });

  it('anchors the volume root itself at /', async () => {
    await setMode('root');
    expect(await hrefsOf('')).toContain('/');
  });

  it('accepts the root-anchored hrefs it advertises, as a Destination', async () => {
    // The half that makes the mode usable at all: a client echoes back the href
    // it was given. Reading the value out of a real 207 rather than hard-coding
    // it is what makes this a contract test instead of a restatement of the
    // implementation.
    const source = await putFile('root-echo-src', 'moved body');
    const target = await putFile('root-echo-dst', 'to be replaced');
    await setMode('root');
    // Free the advertised name, so `Overwrite: F` can prove the destination was
    // genuinely understood rather than silently ignored or mangled.
    const advertised = (await hrefsOf('')).find((h) => h === `/${target}`);
    expect(advertised).toBe(`/${target}`);
    expect((await dav(`/${target}`, { method: 'DELETE' })).status).toBe(204);

    const res = await dav(`/${source}`, {
      method: 'MOVE',
      headers: { Destination: `https://example.com${advertised}`, Overwrite: 'F' },
    });
    expect(res.status).toBe(201);
    expect(await hrefsOf('')).toContain(advertised);
    expect(await (await dav(`/${target}`)).text()).toBe('moved body');
    expect((await dav(`/${source}`)).status).toBe(404);
  });

  it('still addresses its own request URL by the real volume base', async () => {
    // The `pathBase`/`hrefBase` split. If href mode leaked into addressing, the
    // front door's `X-Dav-Path`/`X-Dav-Base` would say root and every lookup
    // would resolve to a nonexistent path — so the whole bucket would read as
    // empty rather than as a wrong href shape.
    const file = await putFile('root-addressing', 'still readable');
    await setMode('root');
    const res = await dav(`/${file}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('still readable');
    expect((await dav('/docs')).status).toBe(200);
    expect((await hrefsOf('docs'))).toContain('/docs/');
  });

  it('keeps the HTML collection listing on the volume base', async () => {
    // Not a `DAV:href`: an `<a href>` a browser resolves against the request
    // URL, which §8.3 does not govern. Anchored at `/` it would 404 on the
    // first click, taking the human-facing directory listing with it.
    await putFile('root-html');
    await setMode('root');
    const res = await dav('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="${DAV_BASE}/docs/"`);
    expect(html).toContain(`href="${DAV_BASE}/t-root-html.txt"`);
  });

  it('rejects a traversal Destination in every encoding, and writes nothing', async () => {
    // Root mode accepts `/etc` as the root-level file `etc`, which is exactly
    // what an escaped `%2e%2e` collapses into. The raw-header check is what
    // keeps the two apart, and this is the case that would silently become a
    // write outside the volume if it were removed.
    const file = await putFile('root-traversal', 'untouched');
    await setMode('root');
    for (const dest of [
      `https://example.com${DAV_BASE}/%2e%2e/%2e%2e/etc`,
      'https://example.com/%2e%2e/%2e%2e/etc',
      'https://example.com/%2E%2E/etc',
      'https://example.com/.%2e/etc',
    ]) {
      const res = await dav(`/${file}`, { method: 'MOVE', headers: { Destination: dest, Overwrite: 'T' } });
      expect(res.status, dest).toBe(400);
    }
    // The source survived every rejected attempt.
    expect(await (await dav(`/${file}`)).text()).toBe('untouched');
    expect((await hrefsOf('')).filter((h) => h.endsWith('etc'))).toEqual([]);
  });

  it('still rejects a cross-origin Destination', async () => {
    const file = await putFile('root-cross-origin');
    await setMode('root');
    const res = await dav(`/${file}`, {
      method: 'COPY',
      headers: { Destination: 'https://evil.example.net/steal', Overwrite: 'T' },
    });
    expect(res.status).toBe(400);
  });

  it('reports the mode through the volume API', async () => {
    await setMode('root');
    const detail = (await (await api(`/user/volumes/${OWNER}/${VOLUME}`)).json()) as { hrefPrefixMode: string };
    expect(detail.hrefPrefixMode).toBe('root');
    const list = (await (await api('/user/volumes')).json()) as { volumes: Array<{ name: string; hrefPrefixMode: string }> };
    expect(list.volumes.find((v) => v.name === VOLUME)?.hrefPrefixMode).toBe('root');
  });

  it('restores the base shape when switched back', async () => {
    await putFile('root-roundtrip');
    await setMode('root');
    expect(await hrefsOf('')).toContain('/t-root-roundtrip.txt');
    await setMode('base');
    const hrefs = await hrefsOf('');
    expect(hrefs).toContain(`${DAV_BASE}/t-root-roundtrip.txt`);
    expect(hrefs).not.toContain('/t-root-roundtrip.txt');
  });

  it('rejects an unknown mode instead of silently coercing it', async () => {
    const res = await api(`/user/volumes/${OWNER}/${VOLUME}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ hrefPrefixMode: 'ROOT' }),
    });
    expect(res.status).toBe(400);
    // The rejected value must not have been stored.
    const detail = (await (await api(`/user/volumes/${OWNER}/${VOLUME}`)).json()) as { hrefPrefixMode: string };
    expect(detail.hrefPrefixMode).toBe('base');
  });
});

describe('href prefix mode: bucket browser plane', () => {
  const filesUrl = (innerPath = ''): string =>
    `/user/volumes/${encodeURIComponent(OWNER)}/${encodeURIComponent(VOLUME)}/files${innerPath === '' ? '' : `/${innerPath}`}`;

  async function listDirectory(innerPath: string): Promise<Array<{ name: string; path: string; isCollection: boolean }>> {
    const res = await api(filesUrl(innerPath), { method: 'PROPFIND', headers: { Depth: '1', ...XML_HEADERS }, body: PROPFIND_BODY });
    expect(res.status, `PROPFIND ${filesUrl(innerPath)}`).toBe(207);
    return parseMultistatus(await res.text(), innerPath, DAV_BASE);
  }

  it('emits root-anchored hrefs in root mode', async () => {
    const file = await putFile('browser-root-hrefs');
    await setMode('root');
    const res = await api(filesUrl(''), { method: 'PROPFIND', headers: { Depth: '1', ...XML_HEADERS }, body: PROPFIND_BODY });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain(`<href>/${file}</href>`);
    expect(xml).not.toContain(`<href>${DAV_BASE}`);
  });

  it('still lists, navigates, and downloads with the real SPA parser in root mode', async () => {
    // The bucket browser must be indifferent to the setting — it strips the
    // prefix when present and copes without it otherwise, and builds its own
    // request URLs from the browser base. Running the real parser over a real
    // body and then using the parsed `path` is what proves that, the same way
    // `SpaBrowserPlane.int.test.ts` does for the default mode.
    const file = await putFile('browser-spa');
    await setMode('root');
    const entries = await listDirectory('');
    const row = entries.find((e) => e.path === file);
    expect(row, `root listing should contain ${file}`).toMatchObject({ name: file, path: file, isCollection: false });
    // Never leaks the listed collection in as its own child.
    expect(entries.map((e) => e.path)).not.toContain('');
    // The volume root's own `<href>` is `/` here, which the parser must reduce
    // to the volume-relative empty path and then drop — otherwise the root
    // renders as a phantom row inside itself.
    expect(entries.map((e) => e.name)).not.toContain('');

    // Navigating with a parsed path has to be a real PROPFIND target.
    const docs = entries.find((e) => e.name === 'docs');
    expect(docs?.isCollection).toBe(true);
    expect(await listDirectory(docs!.path)).toEqual([]);

    // And the parsed path has to work as a download URL.
    const res = await api(filesUrl(encodePath(row!.path)));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('payload');
  });

  it('accepts a browser-shaped Destination in root mode', async () => {
    const file = await putFile('browser-dest');
    await setMode('root');
    const res = await api(filesUrl(file), {
      method: 'MOVE',
      headers: { Destination: `https://example.com${filesUrl(`moved-${file}`)}`, Overwrite: 'F' },
    });
    expect([200, 201, 204]).toContain(res.status);
    expect((await listDirectory('')).map((e) => e.name)).toContain(`moved-${file}`);
  });

  it('answers 502 for a cross-origin Destination, keeping this plane own contract', async () => {
    const file = await putFile('browser-cross-origin');
    await setMode('root');
    const res = await api(filesUrl(file), {
      method: 'MOVE',
      headers: { Destination: 'https://evil.example.net/steal', Overwrite: 'T' },
    });
    expect(res.status).toBe(502);
  });
});

/**
 * Percent-encode each segment, the way `davClient.entryUrl` does.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
