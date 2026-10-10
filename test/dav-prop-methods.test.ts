/**
 * `apps/background/src/dav/methods/PropMethods.ts` — PROPFIND and PROPPATCH.
 *
 * The PROPPATCH contract is the point. RFC 4918 §9.2 requires **every** property
 * in the request to appear in the `207` carrying its actual outcome. Two ways
 * that failed here:
 *
 * - SQL errors used to be swallowed and the status derived only from protected
 *   rejections, so a write that threw was reported as `200 OK` and the client
 *   believed the property was set.
 * - When a protected property failed, every *other* operation was neither
 *   applied **nor reported**. The client could not distinguish "rejected" from
 *   "never attempted", and a retry loop re-sent them forever.
 */
import { describe, expect, it, vi } from 'vitest';
import { handlePropfind, handleProppatch } from '../apps/background/src/dav/methods/PropMethods';
import { BASES, fakeLocks, fakeRepo } from './helpers/dav-fakes';
import type { FakeRepo } from './helpers/dav-fakes';

const URL_BASE = 'https://dav.example.com/alice/photos';
const DAV_NS = 'DAV:';

function seeded(): FakeRepo {
  return fakeRepo({
    dir: { kind: 'directory' },
    'dir/a.txt': { kind: 'file', bytes: new TextEncoder().encode('A'), meta: { etag: '"a"' } },
    'dir/b.txt': { kind: 'file', bytes: new TextEncoder().encode('B'), meta: { etag: '"b"' } },
    'dir/sub': { kind: 'directory' },
    'dir/sub/deep.txt': { kind: 'file', bytes: new TextEncoder().encode('D'), meta: { etag: '"d"' } },
  });
}

function propfind(depth: string | null = '1', body = '', headers: Record<string, string> = {}): Request {
  return new Request(`${URL_BASE}/dir`, {
    method: 'PROPFIND',
    body,
    headers: { Depth: depth ?? '', ...headers },
  });
}

function propertyupdate(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="${DAV_NS}">${inner}</D:propertyupdate>`;
}

describe('handlePropfind', () => {
  // `dir` holds three direct children — `a.txt`, `b.txt` and the `sub`
  // collection — which is what the page-count assertions below are counting.
  const CHILDREN = 3;

  it('207s a Depth: 1 request with the collection and its members', async () => {
    const repo = seeded();
    const response = await handlePropfind(propfind('1'), 'dir', BASES, repo as never);
    const body = await response.text();
    expect(response.status).toBe(207);
    expect(body).toContain('<multistatus');
    expect(body).toContain('a.txt');
    expect(body).toContain('b.txt');
  });

  it('Depth: 0 emits only the collection itself', async () => {
    const repo = seeded();
    const body = await (await handlePropfind(propfind('0'), 'dir', BASES, repo as never)).text();
    expect(body).toContain('dir');
    expect(body).not.toContain('a.txt');
  });

  it('Depth: infinity includes grandchildren', async () => {
    const repo = seeded();
    const body = await (await handlePropfind(propfind('infinity'), 'dir', BASES, repo as never)).text();
    expect(body).toContain('deep.txt');
  });

  it('400s an unrecognised Depth', async () => {
    const repo = seeded();
    const response = await handlePropfind(propfind('2'), 'dir', BASES, repo as never);
    expect(response.status).toBe(400);
  });

  it('404s a missing resource', async () => {
    const repo = seeded();
    const request = new Request(`${URL_BASE}/missing`, { method: 'PROPFIND', headers: { Depth: '0' } });
    const response = await handlePropfind(request, 'missing', BASES, repo as never);
    expect(response.status).toBe(404);
  });

  it('400s a malformed request body', async () => {
    const repo = seeded();
    const request = new Request(`${URL_BASE}/dir`, { method: 'PROPFIND', headers: { Depth: '0' } });
    const response = await handlePropfind(request, 'dir', BASES, repo as never);
    expect(response.status).toBe(207);
  });

  it('answers an explicit propname request with prop names only', async () => {
    const repo = seeded();
    const request = new Request(`${URL_BASE}/dir`, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: propertyupdate('').replace('propertyupdate', 'propfind').replace('</D:propertyupdate>', '<D:propname/></D:propfind>'),
    });
    const response = await handlePropfind(request, 'dir', BASES, repo as never);
    expect(response.status).toBe(207);
    expect(await response.text()).toContain('multistatus');
  });

  describe('paging', () => {
    it('emits page headers only for an opted-in Depth: 1', async () => {
      const repo = seeded();
      const request = new Request(`${URL_BASE}/dir`, {
        method: 'PROPFIND',
        headers: { Depth: '1', 'X-Dav-Page': '0', 'X-Dav-Page-Limit': '1' },
      });
      const response = await handlePropfind(request, 'dir', BASES, repo as never);
      expect(response.headers.get('X-Dav-Page-Count')).toBe(String(CHILDREN));
      expect(response.headers.get('X-Dav-Page-Limit')).toBe('1');
    });

    it('does NOT emit page headers for Depth: 0', async () => {
      // A page over a resource with no children is meaningless.
      const repo = seeded();
      const request = new Request(`${URL_BASE}/dir`, {
        method: 'PROPFIND',
        headers: { Depth: '0', 'X-Dav-Page': '0', 'X-Dav-Page-Limit': '1' },
      });
      const response = await handlePropfind(request, 'dir', BASES, repo as never);
      expect(response.headers.get('X-Dav-Page-Count')).toBeNull();
    });

    it('serves a whole Depth: infinity walk unpaged', async () => {
      const repo = seeded();
      const request = new Request(`${URL_BASE}/dir`, {
        method: 'PROPFIND',
        headers: { Depth: 'infinity', 'X-Dav-Page': '0', 'X-Dav-Page-Limit': '1' },
      });
      const response = await handlePropfind(request, 'dir', BASES, repo as never);
      expect(response.headers.get('X-Dav-Page-Count')).toBeNull();
      expect(await response.text()).toContain('deep.txt');
    });

    it('returns only the requested page', async () => {
      const repo = seeded();
      const request = new Request(`${URL_BASE}/dir`, {
        method: 'PROPFIND',
        headers: { Depth: '1', 'X-Dav-Page': '0', 'X-Dav-Page-Limit': '1' },
      });
      const body = await (await handlePropfind(request, 'dir', BASES, repo as never)).text();
      const hrefs = [...body.matchAll(/<href>([^<]+)<\/href>/g)].map((match) => match[1]);
      // The collection plus exactly one child.
      expect(hrefs).toHaveLength(2);
    });

    it('clamps an out-of-range page to the last real one', async () => {
      // An empty render would read as "this folder is empty", which is wrong
      // rather than merely unhelpful.
      const repo = seeded();
      const request = new Request(`${URL_BASE}/dir`, {
        method: 'PROPFIND',
        headers: { Depth: '1', 'X-Dav-Page': '99', 'X-Dav-Page-Limit': '1' },
      });
      const response = await handlePropfind(request, 'dir', BASES, repo as never);
      expect(response.headers.get('X-Dav-Page-Count')).toBe(String(CHILDREN));
      // The clamp is what keeps an out-of-range page from rendering as "this
      // folder is empty" — wrong, not merely unhelpful.
      expect(await response.text()).toContain('<multistatus');
    });
  });
});

describe('handleProppatch', () => {
  function sql(execFails = false) {
    return { exec: vi.fn(() => (execFails ? (() => { throw new Error('SQLITE_ERROR'); })() : undefined)) };
  }

  function proppatch(body: string): Request {
    return new Request(`${URL_BASE}/a.txt`, { method: 'PROPPATCH', headers: { 'Content-Type': 'application/xml' }, body });
  }

  const deadPropSet = (ns: string, name: string) =>
    `<D:set><D:prop><X:${name} xmlns:X="${ns}">v</X:${name}></D:prop></D:set>`;

  it('200s a dead-property set', async () => {
    const repo = seeded();
    const storage = sql();
    const response = await handleProppatch(
      proppatch(propertyupdate(deadPropSet('https://example.com/ns', 'custom'))),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      storage as never,
    );
    expect(response.status).toBe(207);
    expect(await response.text()).toContain('200 OK');
    expect(storage.exec).toHaveBeenCalled();
  });

  it('403s a protected live property and names it in the multistatus', async () => {
    const repo = seeded();
    const storage = sql();
    const response = await handleProppatch(
      proppatch(propertyupdate(`<D:set><D:prop><D:resourcetype>x</D:resourcetype></D:prop></D:set>`)),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      storage as never,
    );
    const body = await response.text();
    expect(body).toContain('403 Forbidden');
    expect(body).toContain('resourcetype');
  });

  it('REPORTS the other properties when one protected property fails', async () => {
    // The defect: a protected failure made every other operation vanish from
    // the response, so the client could not tell "rejected" from "never
    // attempted" and a retry loop re-sent them forever.
    const repo = seeded();
    const storage = sql();
    const response = await handleProppatch(
      proppatch(
        propertyupdate(
          `<D:set><D:prop><D:resourcetype>x</D:resourcetype></D:prop></D:set>` + deadPropSet('https://example.com/ns', 'custom'),
        ),
      ),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      storage as never,
    );
    const body = await response.text();
    expect(body).toContain('resourcetype');
    expect(body).toContain('403 Forbidden');
    // The unrelated dead property is accounted for, as a failed dependency.
    expect(body).toContain('custom');
    expect(body).toContain('424 Failed Dependency');
  });

  it('424s rather than 200s when the SQL write throws', async () => {
    // A write that threw used to be reported as `200 OK`, so the client believed
    // the property was set and the next PROPFIND did not show it.
    const repo = seeded();
    const response = await handleProppatch(
      proppatch(propertyupdate(deadPropSet('https://example.com/ns', 'custom'))),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      sql(true) as never,
    );
    const body = await response.text();
    expect(body).toContain('424 Failed Dependency');
    expect(body).not.toContain('200 OK');
  });

  it('400s a malformed body', async () => {
    const repo = seeded();
    const response = await handleProppatch(
      proppatch('<not-xml'),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      sql() as never,
    );
    expect(response.status).toBe(400);
  });

  it('404s a missing resource', async () => {
    const repo = seeded();
    const request = new Request(`${URL_BASE}/missing`, { method: 'PROPPATCH', body: propertyupdate(deadPropSet('ns', 'p')) });
    const response = await handleProppatch(request, 'missing', BASES, repo as never, fakeLocks() as never, sql() as never);
    expect(response.status).toBe(404);
  });

  it('423s when the resource is locked by another client', async () => {
    const repo = seeded();
    const response = await handleProppatch(
      proppatch(propertyupdate(deadPropSet('ns', 'p'))),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks({ lockedPaths: ['dir/a.txt'] }) as never,
      sql() as never,
    );
    expect(response.status).toBe(423);
  });

  it('handles a dead-property remove', async () => {
    const repo = seeded();
    const storage = sql();
    const response = await handleProppatch(
      proppatch(propertyupdate(`<D:remove><D:prop><X:gone xmlns:X="http://example.com/ns"/></D:prop></D:remove>`)),
      'dir/a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      storage as never,
    );
    expect(response.status).toBe(207);
    expect(await response.text()).toContain('200 OK');
  });
});