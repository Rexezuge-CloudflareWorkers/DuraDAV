import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';

/**
 * The header set both front-door planes hand to the DO.
 *
 * This was previously written twice — once in `DavReadServing.davHeaders` for
 * the WebDAV plane, once inline in `VolumeBrowserRoutes` — and the two had
 * already drifted: only the browser plane stripped a caller-supplied
 * `X-Dav-Page*`, and only the DAV plane overwrote `X-Dav-Href-Prefix-Mode`
 * unconditionally. Both differences were bugs, so the shape is now stated once
 * and both planes call it.
 *
 * The invariants below are security properties, not conveniences. Each one is
 * an "overwrite, never inherit" rule, because the DO has no auth of its own:
 * anything a client can set and the DO will read is a hole.
 */

/**
Request headers the DO reads for paging. Only this plane's code may set them.
*/
const PAGE_HEADERS = ['X-Dav-Page', 'X-Dav-Page-Limit'] as const;

export interface DavForwardOptions {
  /**
  The volume's real `/owner/volume` prefix. Drives the DO's request addressing.
  */
  base: string;
  /**
  Volume-relative path, with no leading or trailing slash.
  */
  inner: string;
  /**
  The bucket's own setting. Presentation only — never derived from the request.
  */
  hrefPrefixMode: DavHrefPrefixMode;
  /**
  The owner's resolved current sign-in address, or `null` for a truly anonymous read.
  */
  userEmail: string | null;
  /**
   * A `Destination` already canonicalised by `resolveDestination`. Set only on
   * COPY/MOVE; a `Destination` on any other method is dropped rather than
   * forwarded, because the DO has no use for it and forwarding it hands a
   * client-controlled header to code that might later start reading it.
   */
  destination?: string;
  /**
   * Browser-plane paging, already resolved from `?page=`/`?limit=`. `null` on
   * the WebDAV plane, which never pages: RFC 4918 §9.1 has no paging concept,
   * so a paged 207 there would be a truncated multistatus.
   */
  page?: { page: string | null; limit: string | null } | null;
}

function applyDavForwardHeaders(source: Headers, options: DavForwardOptions): Headers {
  const { base, inner, hrefPrefixMode, userEmail, destination, page } = options;
  const h = new Headers(source);

  h.set('X-Dav-Base', base);
  h.set('X-Dav-Path', inner);

  // Always overwrite. Setting it only when authenticated, or only on one plane,
  // let a client-supplied `X-Dav-Href-Prefix-Mode: root` reach the DO untouched
  // and silently change the addressing shape of a bucket whose owner chose
  // `base`.
  h.set('X-Dav-Href-Prefix-Mode', hrefPrefixMode);

  // Always overwrite. Setting it only when authenticated let a client-supplied
  // `X-Dav-User: admin@…` through untouched on an anonymous read of a public
  // volume. Nothing consumes it today, but it is a header-injection primitive
  // one refactor away from mattering.
  //
  // The value is the owner's *current* sign-in address (resolved from
  // `owner_user_id` in `DavAuth`), not the frozen `owner_email` anchor, so the
  // DO never records an address the owner does not actually use. It is still
  // attacker-controllable in the sense that any bucket credential holder can
  // reach the owner of that bucket — which is the credential's entire purpose.
  h.set('X-Dav-User', userEmail ?? '');

  // Paging is opt-in per request and only this function may opt in. Deleting
  // first is what makes the "a native DAV client is structurally unaffected"
  // claim true: a hand-set header on the DAV plane used to survive, truncate a
  // `Depth: 1` multistatus, and — because the read-cache key carries no page
  // term — serve that truncated body to every later unpaged PROPFIND.
  for (const header of PAGE_HEADERS) h.delete(header);
  if (page) {
    if (page.page !== null) h.set('X-Dav-Page', page.page);
    if (page.limit !== null) h.set('X-Dav-Page-Limit', page.limit);
  }

  // The DO never reads Authorization; do not hand credentials down. On the
  // browser plane the caller's session identity is authoritative, so a Basic
  // header there is ambient noise rather than intent.
  h.delete('Authorization');

  // Dropped unless the caller resolved one: the DO only ever acts on a
  // `Destination` for COPY/MOVE.
  h.delete('Destination');
  if (destination !== undefined) h.set('Destination', destination);

  return h;
}

export { applyDavForwardHeaders, PAGE_HEADERS };
