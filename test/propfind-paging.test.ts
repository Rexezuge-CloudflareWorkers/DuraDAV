import { describe, expect, it } from 'vitest';
import { pagingHeaders, readPagingHeaders, resolvePaging } from '../apps/background/src/dav/PropfindPaging';

function request(headers: Record<string, string>): Request {
  return new Request('https://dav.example/owner/volume/', { method: 'PROPFIND', headers });
}

describe('paging headers are opt-in', () => {
  /**
   * RFC 4918 §9.1: `Depth: 1` means "all members". A default page here would
   * silently truncate every WebDAV client's listing, so absence must mean
   * "no paging" and not "page 1 of 100".
   */
  it('reports no paging for a request that asked for none', () => {
    expect(readPagingHeaders(request({ Depth: '1' }))).toBeNull();
  });

  it('reports paging when the page is present', () => {
    expect(readPagingHeaders(request({ 'X-Dav-Page': '2' }))).toEqual({ page: '2', limit: null });
  });

  it('reports paging when only the limit is present', () => {
    // `?limit=50` with no `?page=` is a first-page request at size 50, and
    // treating it as absent would ignore the size the caller asked for.
    expect(readPagingHeaders(request({ 'X-Dav-Page-Limit': '50' }))).toEqual({ page: null, limit: '50' });
  });

  it('passes values through as raw strings for the DO to clamp once', () => {
    expect(readPagingHeaders(request({ 'X-Dav-Page': '99', 'X-Dav-Page-Limit': '100000' }))).toEqual({ page: '99', limit: '100000' });
  });
});

describe('resolving effective paging', () => {
  it('resolves a normal request unchanged', () => {
    expect(resolvePaging({ page: '2', limit: '50' }, 12_431)).toEqual({ page: 2, limit: 50, offset: 50, total: 12_431 });
  });

  it('defaults the page to 1 and the size to 100 when the headers are absent', () => {
    expect(resolvePaging({ page: null, limit: null }, 10)).toEqual({ page: 1, limit: 100, offset: 0, total: 10 });
  });

  it('clamps a page past the end to the last real page', () => {
    const resolved = resolvePaging({ page: '99', limit: '100' }, 12);
    expect(resolved.page).toBe(1);
    expect(resolved.offset).toBe(0);
    expect(resolved.total).toBe(12);
  });

  it('clamps an oversized limit so the page cannot be made to hydrate everything', () => {
    expect(resolvePaging({ page: '1', limit: '100000' }, 12_431).limit).toBe(250);
  });

  it('clamps a hostile page number to a page 1 offset rather than a huge one', () => {
    const resolved = resolvePaging({ page: '-1', limit: '100' }, 12_431);
    expect(resolved.page).toBe(1);
    expect(resolved.offset).toBe(0);
  });

  it('reports page 1 for an empty collection', () => {
    expect(resolvePaging({ page: '4', limit: '100' }, 0)).toEqual({ page: 1, limit: 100, offset: 0, total: 0 });
  });

  it('bases the last-page clamp on the effective size, not the requested one', () => {
    // `limit=10000` clamps to 250, so 12431 entries span 50 pages, not 2.
    const resolved = resolvePaging({ page: '50', limit: '10000' }, 12_431);
    expect(resolved.limit).toBe(250);
    expect(resolved.page).toBe(50);
  });
});

describe('paging response headers', () => {
  it('reports the total, the page served, and the size used', () => {
    expect(pagingHeaders({ page: 2, limit: 50, offset: 50, total: 12_431 })).toEqual({
      'X-Dav-Page-Count': '12431',
      'X-Dav-Page': '2',
      'X-Dav-Page-Limit': '50',
    });
  });

  /**
   * `X-Dav-Page-Count` is the presence marker, not just data: a client that
   * does not see it was talking to a server that does not page, and must not
   * read a truncated body as a complete listing.
   */
  it('always includes the count, so a client can tell paged from unpaged', () => {
    const headers = pagingHeaders({ page: 1, limit: 100, offset: 0, total: 0 });
    expect(headers['X-Dav-Page-Count']).toBe('0');
    expect(headers['X-Dav-Page']).toBe('1');
  });

  it('echoes the clamped page rather than the requested one', () => {
    const resolved = resolvePaging({ page: '99', limit: '100' }, 12);
    expect(pagingHeaders(resolved)['X-Dav-Page']).toBe('1');
  });
});
