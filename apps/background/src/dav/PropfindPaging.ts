// The `listing` subpath, not the package barrel: the barrel also exports
// `dofs`, which imports `cloudflare:workers` and cannot be loaded by the root
// Vitest suite. `listing` is pure arithmetic and pulls in nothing.
import { clampPageNumber, clampPageSize, clampPageToCollection, offsetForPage } from '@durable-dav/dav-store/listing';

/**
 * Paging for `Depth: 1` PROPFIND, opt-in via request headers.
 *
 * RFC 4918 §9.1 has no concept of a paged listing: `Depth: 1` means "all
 * members of this collection". So paging here is driven by headers the browser
 * plane sets and the WebDAV plane never sets — a native DAV client is
 * structurally unaffected and still receives every member, and the `DavReadCache`
 * key (`[volume, path, depth, bodyHash]`) can stay as-is because only the
 * browser plane pages and only the WebDAV plane reads that cache.
 *
 * Request:  `X-Dav-Page`, `X-Dav-Page-Limit`
 * Response: `X-Dav-Page-Count`, `X-Dav-Page`, `X-Dav-Page-Limit`
 *
 * `X-Dav-Page-Count` is the presence marker, not just data: a client that does
 * not see it was talking to a server that does not page, and must not assume a
 * truncated body is a complete listing.
 */

/**
Effective paging for a request, after clamping.
*/
export interface DavPaging {
  /**
  1-based page actually served, after the last-page clamp.
  */
  page: number;
  /**
  Page size actually used, after clamping.
  */
  limit: number;
  /**
  0-based row offset into the ordered child list.
  */
  offset: number;
  /**
  Direct children in the collection, as the DO counts them.
  */
  total: number;
}

/**
 * Read paging headers from a request.
 *
 * Returns `null` — not a default page — when the caller did not ask for
 * paging. A defaulted page here would silently truncate every WebDAV client's
 * listing, which is the one outcome RFC 4918 makes unacceptable.
 */
export function readPagingHeaders(request: Request): { page: unknown; limit: unknown } | null {
  const rawPage = request.headers.get('X-Dav-Page');
  const rawLimit = request.headers.get('X-Dav-Page-Limit');
  return rawPage === null && rawLimit === null ? null : { page: rawPage, limit: rawLimit };
}

/**
 * Resolve effective paging against a known collection size.
 *
 * The clamp order matters: size and page number are validated independently of
 * the total (they arrive as strings from a header), and only then is the page
 * bounded by the real last page. A `?page=99` on a 12-entry folder therefore
 * serves page 1 rather than an empty list.
 */
export function resolvePaging(requested: { page: unknown; limit: unknown }, total: number): DavPaging {
  const limit = clampPageSize(requested.limit);
  const page = clampPageToCollection(clampPageNumber(requested.page), total, limit);
  return { page, limit, offset: offsetForPage(page, limit), total };
}

/**
 * Response headers describing what was actually served.
 *
 * `X-Dav-Page`/`X-Dav-Page-Limit` echo the *effective* values, not the
 * requested ones, so a client that asked for page 99 of a 1-page collection
 * learns that it is on page 1 and can correct its own link.
 */
export function pagingHeaders(paging: DavPaging): Record<string, string> {
  return {
    'X-Dav-Page-Count': String(paging.total),
    'X-Dav-Page': String(paging.page),
    'X-Dav-Page-Limit': String(paging.limit),
  };
}

export { pageCountFor } from '@durable-dav/dav-store/listing';
