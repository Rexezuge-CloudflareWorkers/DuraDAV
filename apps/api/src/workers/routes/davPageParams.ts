/**
 * Query-parameter paging for the browser plane.
 *
 * The browser asks for a page with `?page=`/`?limit=` rather than headers
 * because the Durable-DAV-Router forwards query strings verbatim
 * (`joinBackendUrlWithoutSelector` keeps `search` and strips only `backend=`),
 * whereas a new request header would need adding to its allowlist. The Router
 * therefore needs no request-header change for this feature.
 *
 * The parameters are consumed here and re-emitted as `X-Dav-Page*` request
 * headers, because the DO's request URL is rebuilt from the DAV base
 * (`VolumeBrowserRoutes`) and would otherwise never see them.
 */

/**
Parsed paging request from the browser plane's query string.
*/
export interface DavPageParams {
  page: string | null;
  limit: string | null;
}

/**
 * Read `?page=`/`?limit=` off a URL.
 *
 * Returns `null` when neither is present, so the common case (no query string
 * at all, e.g. a DAV client, or a share link) does not accidentally opt into
 * paging. Values are passed through as raw strings: clamping happens once, in
 * the DO, which is the only place that can be authoritative about them.
 */
export function readPageParams(url: URL): DavPageParams | null {
  const page = url.searchParams.get('page');
  const limit = url.searchParams.get('limit');
  return page === null && limit === null ? null : { page, limit };
}

/**
 * `url` with `page` and `limit` removed, preserving every other parameter.
 *
 * Non-paging parameters must survive the hop to the DO untouched, and the
 * delete-then-set order is deliberate: setting first could leave a stale `page`
 * behind when the new value is empty, and `URLSearchParams.delete` on a name
 * that is absent is a no-op, so the absent case needs no guard.
 */
export function stripPageParams(url: URL): URL {
  const stripped = new URL(url.href);
  stripped.searchParams.delete('page');
  stripped.searchParams.delete('limit');
  return stripped;
}
