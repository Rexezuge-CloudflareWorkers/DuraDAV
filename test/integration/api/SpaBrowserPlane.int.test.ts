import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';
import { parseMultistatus } from '../../../apps/web/src/lib/davXml';

/**
 * Browser-plane ⇄ SPA contract.
 *
 * The bucket browser is the only consumer that must agree with the server about
 * *path addressing*: the SPA takes a `DAV:href` out of the 207 body, strips the
 * volume base to get a volume-relative `path`, and then feeds that `path` straight
 * back into the next request URL. Nothing else in the codebase closes that loop.
 *
 * The gap this suite fills: `DavLifecycle.int.test.ts` PROPFINDs only the volume
 * *root* through the browser plane and asserts merely `toContain('multistatus')`.
 * So a parser that never stripped the volume base shipped green — the root
 * listing rendered the volume root itself as a phantom row, and every follow-up
 * request (`files/test/bucket/docs`, download `files/test/bucket/readme.txt`)
 * 404'd, i.e. the browser could not open any file or directory.
 *
 * These tests therefore always pair "parse the real body" with "use the parsed
 * `path` in a real request", because a parser/server disagreement is invisible
 * when either half is checked alone.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

const VOLUME = 'spabrowse';
// Must match `DEV_AUTH_EMAIL` in `wrangler.test.jsonc`.
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>';

/**
 * The handle the `users` row actually carries. `ensureUser` writes the username
 * with `COALESCE`, so a row seeded by an earlier suite keeps its original handle.
 */
let OWNER = 'spauser';
/**
Volume base as it appears in `DAV:href` (RFC 4918 §8.3).
*/
let DAV_BASE = `/${OWNER}/${VOLUME}`;

const api = (path: string, init: RequestInit = {}): Promise<Response> => SELF.fetch(`https://example.com${path}`, init);

/**
Browser-plane path for a volume-relative path (`''` is the volume root).
*/
const filesUrl = (innerPath = ''): string => `/user/volumes/${encodeURIComponent(OWNER)}/${encodeURIComponent(VOLUME)}/files${innerPath === '' ? '' : `/${innerPath}`}`;

/**
 * The real request the SPA makes: PROPFIND `Depth: 1` at the browser plane,
 * parsed by the real SPA parser. Throws on a non-207 so a failure names the
 * status instead of silently yielding an empty listing.
 */
async function listDirectory(innerPath: string): Promise<Array<{ name: string; path: string; isCollection: boolean }>> {
  const res = await api(filesUrl(innerPath), {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  });
  expect(res.status, `PROPFIND ${filesUrl(innerPath)}`).toBe(207);
  return parseMultistatus(await res.text(), innerPath, DAV_BASE);
}

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await setupIntegrationTest(testEnv, EMAIL);
  await ensureUser(testEnv.DB, EMAIL, OWNER);
  const row = await testEnv.DB.prepare(`SELECT username FROM users WHERE email = ?`).bind(EMAIL).first<{ username: string | null }>();
  OWNER = row?.username ?? OWNER;
  DAV_BASE = `/${OWNER}/${VOLUME}`;
  expect(OWNER).not.toBe('');

  await api('/user/volumes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ owner: OWNER, name: VOLUME }) });

  // Nested tree, plus a name that needs percent-encoding on the way back out.
  expect((await api(filesUrl('docs'), { method: 'MKCOL' })).status).toBe(201);
  expect((await api(filesUrl('docs/raw'), { method: 'MKCOL' })).status).toBe(201);
  expect((await api(filesUrl('my folder'), { method: 'MKCOL' })).status).toBe(201);
  expect((await api(filesUrl('readme.txt'), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'root file' })).status).toBe(201);
  expect((await api(filesUrl('docs/notes.txt'), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'nested file' })).status).toBe(
    201,
  );
  expect((await api(filesUrl('docs/raw/p q.txt'), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'spaced file' })).status).toBe(
    201,
  );
});

describe('SPA bucket browser ⇄ WebDAV addressing contract', () => {
  it('strips the volume base from hrefs so root entries are volume-relative', async () => {
    const entries = await listDirectory('');
    expect(entries.map((e) => [e.name, e.path, e.isCollection])).toEqual([
      ['docs', 'docs', true],
      ['my folder', 'my folder', true],
      ['readme.txt', 'readme.txt', false],
    ]);
  });

  it('never leaks the listed collection itself into the listing', async () => {
    // The self `<response>` is the one entry whose href equals the request
    // target. Unstripped, the volume root appeared at the volume root and a
    // subdirectory appeared as its own child — a "folder contains itself" row
    // whose `path` 404'd on click.
    for (const innerPath of ['', 'docs', 'docs/raw']) {
      const entries = await listDirectory(innerPath);
      expect(entries.map((e) => e.path)).not.toContain(innerPath);
      for (const entry of entries) {
        expect(entry.path, `${innerPath || '<root>'} listing`).not.toBe('');
        // A child must be strictly below the folder being listed, never a
        // sibling or an ancestor.
        expect(entry.path.startsWith(innerPath === '' ? '' : `${innerPath}/`)).toBe(true);
      }
    }
  });

  it('lists a subdirectory with volume-relative paths, not root-relative ones', async () => {
    const entries = await listDirectory('docs');
    expect(entries.map((e) => [e.name, e.path, e.isCollection])).toEqual([
      ['raw', 'docs/raw', true],
      ['notes.txt', 'docs/notes.txt', false],
    ]);
  });

  it('lists a deeply nested subdirectory', async () => {
    const entries = await listDirectory('docs/raw');
    expect(entries.map((e) => [e.name, e.path, e.isCollection])).toEqual([['p q.txt', 'docs/raw/p q.txt', false]]);
  });

  it('downloads a file using the path the parser produced', async () => {
    // The round trip that actually matters: the SPA navigates with exactly this
    // `path`, so a parser that left the volume base on would request
    // `files/test/spabrowse/readme.txt` and get a 404.
    for (const [innerPath, expected] of [
      ['', 'root file'],
      ['docs', 'nested file'],
      ['docs/raw', 'spaced file'],
    ] as const) {
      const entries = await listDirectory(innerPath);
      const file = entries.find((e) => !e.isCollection);
      expect(file, `a file in ${innerPath || '<root>'}`).toBeDefined();
      const res = await api(filesUrl(encodePath(file!.path)));
      expect(res.status, `GET ${filesUrl(file!.path)}`).toBe(200);
      expect(await res.text()).toBe(expected);
    }
  });

  it('navigates into a folder using the path the parser produced', async () => {
    const [folder] = await listDirectory('');
    expect(folder?.isCollection).toBe(true);
    // The SPA's `openPreview` pushes `entry.path` into `?path=`; that value has
    // to be a real PROPFIND target, or clicking a folder cannot open it.
    const entries = await listDirectory(folder!.path);
    expect(entries.map((e) => e.path)).toContain('docs/notes.txt');
  });

  it('renames within a subdirectory using the parsed parent path', async () => {
    const file = (await listDirectory('docs/raw')).find((e) => !e.isCollection);
    const parent = file!.path.slice(0, file!.path.lastIndexOf('/'));
    const res = await api(filesUrl(encodePath(file!.path)), {
      method: 'MOVE',
      headers: { Destination: `https://example.com${filesUrl(encodePath(`${parent}/renamed.txt`))}`, Overwrite: 'T' },
    });
    expect([200, 201, 204]).toContain(res.status);
    expect((await listDirectory('docs/raw')).map((e) => e.name)).toEqual(['renamed.txt']);
  });

  it('answers 404 for a folder that does not exist, so the UI shows its missing state', async () => {
    const res = await api(filesUrl('no-such-folder'), {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Paged listing, through the real browser plane and the real DO.
 *
 * A paged body is *wrong* in a way an unpaged one is not: a missing entry or a
 * repeated one across two pages is invisible when only one page is inspected,
 * which is exactly the failure the pager would ship with. So these tests
 * compare adjacent pages against the unpaged listing rather than asserting each
 * page's contents in isolation.
 */
describe('browser-plane paged listing', () => {
  /**
  Enough entries to span several pages at the smallest page size.
  */
  const ENTRY_COUNT = 12;
  const PAGE_SIZE = 5;
  const FOLDER = 'paged';

  /**
  Paged PROPFIND with paging headers, parsed by the real SPA parser.
  */
  async function listPage(innerPath: string, page: number, limit: number): Promise<{ entries: Array<{ path: string }>; total: number | null; servedPage: number | null; servedLimit: number | null }> {
    const res = await api(`${filesUrl(innerPath)}?page=${page}&limit=${limit}`, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    expect(res.status).toBe(207);
    return {
      entries: parseMultistatus(await res.text(), innerPath, DAV_BASE),
      total: readHeader(res, 'X-Dav-Page-Count'),
      servedPage: readHeader(res, 'X-Dav-Page'),
      servedLimit: readHeader(res, 'X-Dav-Page-Limit'),
    };
  }

  beforeAll(async () => {
    expect((await api(filesUrl(FOLDER), { method: 'MKCOL' })).status).toBe(201);
    for (let i = 0; i < ENTRY_COUNT; i += 1) {
      const name = `entry-${String(i).padStart(2, '0')}.txt`;
      const res = await api(filesUrl(`${FOLDER}/${name}`), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: name });
      expect(res.status, name).toBe(201);
    }
  });

  it('reports the collection size and the page it served', async () => {
    const page = await listPage(FOLDER, 1, PAGE_SIZE);
    expect(page.total).toBe(ENTRY_COUNT);
    expect(page.servedPage).toBe(1);
    expect(page.servedLimit).toBe(PAGE_SIZE);
  });

  it('returns only the requested page', async () => {
    const page = await listPage(FOLDER, 1, PAGE_SIZE);
    expect(page.entries).toHaveLength(PAGE_SIZE);
  });

  /**
   * The load-bearing property. A non-deterministic ORDER BY would let SQLite
   * return the same directory in a different order on two consecutive requests,
   * which is how an entry ends up on two pages or on none. `dofs_files` carries
   * `is_dir`, and the query orders by `is_dir DESC, name COLLATE NOCASE, name` —
   * the trailing binary `name` is what makes the order total.
   */
  it('walks every entry exactly once across all pages', async () => {
    const full = (await listDirectory(FOLDER)).map((e) => e.path).sort();
    const paged: string[] = [];
    for (let page = 1; page <= Math.ceil(ENTRY_COUNT / PAGE_SIZE); page += 1) {
      paged.push(...(await listPage(FOLDER, page, PAGE_SIZE)).entries.map((e) => e.path));
    }
    expect(paged).toHaveLength(ENTRY_COUNT);
    // Disjoint, and equal to the unpaged listing as a set.
    expect(new Set(paged).size).toBe(ENTRY_COUNT);
    expect([...paged].sort()).toEqual(full);
  });

  it('orders folders before files, matching the unpaged listing', async () => {
    const full = (await listDirectory(FOLDER)).map((e) => e.path);
    const paged: string[] = [];
    for (let page = 1; page <= Math.ceil(ENTRY_COUNT / PAGE_SIZE); page += 1) {
      paged.push(...(await listPage(FOLDER, page, PAGE_SIZE)).entries.map((e) => e.path));
    }
    // The paged order and the unpaged order are the same total order, so the
    // browser's within-page re-sort is all that differs.
    expect(paged).toEqual(full);
  });

  /**
   * An out-of-range page must serve the last real page. Serving an empty list
   * would be a *wrong* answer rather than an unhelpful one: `VolumeFileList`
   * gates its "folder does not exist" state on `entries.length === 0`.
   */
  it('clamps a page past the end to the last real page instead of answering empty', async () => {
    const page = await listPage(FOLDER, 99, PAGE_SIZE);
    expect(page.servedPage).toBe(Math.ceil(ENTRY_COUNT / PAGE_SIZE));
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it('clamps an oversized limit so one request cannot ask for the whole collection', async () => {
    const page = await listPage(FOLDER, 1, 100_000);
    expect(page.servedLimit).toBe(250);
    expect(page.entries.length).toBeLessThanOrEqual(250);
  });

  it('reports no paging headers when the caller did not ask to page', async () => {
    // A native DAV client sends `Depth: 1` and must still receive every member
    // (RFC 4918 §9.1). The absence of these headers is also what tells an older
    // SPA that the listing it got is complete rather than one page of many.
    const res = await api(filesUrl(FOLDER), {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('X-Dav-Page-Count')).toBeNull();
    expect(parseMultistatus(await res.text(), FOLDER, DAV_BASE)).toHaveLength(ENTRY_COUNT);
  });

  it('ignores a caller-set X-Dav-Page header unless the query string asked for it', async () => {
    // The browser plane decides paging from `?page=`/`?limit=`; a hand-set
    // header must not page a request that never opted in.
    const res = await api(filesUrl(FOLDER), {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'X-Dav-Page': '2', 'X-Dav-Page-Limit': '2' },
      body: PROPFIND_BODY,
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('X-Dav-Page-Count')).toBeNull();
    expect(parseMultistatus(await res.text(), FOLDER, DAV_BASE)).toHaveLength(ENTRY_COUNT);
  });

  it('keeps other query parameters, so paging cannot drop an unrelated one', async () => {
    const res = await api(`${filesUrl(FOLDER)}?page=1&limit=${PAGE_SIZE}&backend=keepme`, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('X-Dav-Page-Count')).toBe(String(ENTRY_COUNT));
  });
});

function readHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
Percent-encode each segment, the way `davClient.entryUrl` does.
*/
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
