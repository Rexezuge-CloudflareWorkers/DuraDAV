import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';
import { stripSlashes } from '@durable-dav/webdav';

/**
 * `Destination` canonicalisation for both front-door planes.
 *
 * The DO's contract is deliberately narrow: a `Destination` it receives *always*
 * carries the `/owner/volume` base, and `stripBase` is the only thing that maps
 * it to a volume-relative path. This module is what makes that true.
 *
 * Why the front door and not the DO: the href prefix mode changes what a client
 * legitimately sends back. A `root`-mode bucket hands out `/docs/a.txt`, and
 * Finder/Explorer will hand that straight back as
 * `Destination: https://host/docs/a.txt`. The DO cannot tell that apart from the
 * `%2e%2e` escape it currently rejects *by counting segments* — in root mode a
 * single-segment `/etc` is a legal root-level file. So the DO is never asked to
 * resolve two shapes; the front door, which knows the mode, collapses them into
 * one before forwarding.
 *
 * That also upgrades the traversal guard. `stripBase`'s defence is
 * "a non-base-prefixed path must have at least two segments", which works only
 * because the WHATWG URL parser eats `%2e%2e` first. Here the check runs on the
 * **raw header**, before any URL parsing, so the escape is caught by name
 * instead of by arity — and the DO's `isValidInnerPath` remains as a backstop.
 */

export type DestinationFailure = 'absent' | 'invalid' | 'cross-origin';

export type DestinationResolution =
  | { ok: true; destination: string }
  | { ok: false; reason: DestinationFailure; status: number };

/**
 * The path portion of the header *before* URL resolution.
 *
 * A `Destination` may be absolute (`https://host/…`), absolute-path
 * (`/owner/vol/x`), or relative (`x`, or `../x`). Only the first two carry a
 * pathname we can inspect; a relative one inherits the request URL's segments
 * and is therefore covered by inspecting the resolved URL below.
 */
function rawPathOf(header: string): string | null {
  const schemeEnd = header.indexOf('://');
  if (schemeEnd === -1) return header.startsWith('/') ? header : null;
  const afterScheme = header.indexOf('/', schemeEnd + 3);
  return afterScheme === -1 ? '/' : header.slice(afterScheme);
}

/**
 * Reject a path carrying a `.`/`..` segment in any encoding.
 *
 * `/^\.{1,2}$/` on the decoded segment is what makes this encoding-proof: it
 * catches `.`, `..`, `%2e%2e`, `%2E%2E`, and the mixed `.%2e`. Bounded at two
 * because those two are the *only* segments the WHATWG URL parser removes — a
 * file legitimately named `...` is storable and addressable today
 * (`isValidInnerPath` allows it), so a looser `^\.+$` would reject a path the
 * rest of the server is happy to serve.
 *
 * A decode failure leaves the raw segment, which then has to literally be dots
 * to match — so a malformed escape is not silently treated as a dot segment.
 *
 * Deliberately *not* rejecting `%2f`: a percent-encoded slash is not a dot
 * segment, and smuggling one is already caught downstream by
 * `isValidInnerPath`, which runs after the DO's per-segment decode.
 */
function hasDotSegment(pathname: string): boolean {
  return pathname
    .split('/')
    .some((segment) => {
      if (segment === '') return false;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment; only a literal all-dots value can match.
      }
      return /^\.{1,2}$/.test(decoded);
    });
}

/**
 * Inner path of a browser-plane destination, or `null` if it is not one.
 *
 * Browser prefix is `/user/volumes/<owner>/<vol>/files/<inner>`, which the SPA
 * uses as its request base and therefore as its `Destination` for COPY/MOVE.
 */
function browserInnerFrom(pathname: string): string | null {
  const parts = stripSlashes(pathname).split('/');
  return parts.length < 5 || parts[0] !== 'user' || parts[1] !== 'volumes' || parts[4] !== 'files' ? null : parts.slice(5).join('/');
}

/**
 * Map an already-percent-encoded pathname to a volume-relative one.
 *
 * Returns `null` when the path names neither the volume base nor, in root mode,
 * a plausible in-volume path. Kept on the encoded string on purpose: decoding
 * and re-encoding a client path here would risk changing the bytes the DO later
 * decodes, and the base itself is always plain ASCII (`/owner/volume`), so the
 * prefix test needs no decoding either.
 */
function innerFromPathname(pathname: string, pathBase: string, mode: DavHrefPrefixMode): string | null {
  const base = stripSlashes(pathBase);
  const clean = stripSlashes(pathname);
  if (base === '') return clean;
  if (clean.toLowerCase() === base.toLowerCase()) return '';
  if (clean.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return clean.slice(base.length + 1);
  // Not base-prefixed. Only a `root`-mode bucket can legitimately be addressed
  // this way, because that is the href shape it advertised.
  return mode === 'root' ? clean : null;
}

/**
 * Resolve a client `Destination` to the canonical DAV-base form.
 *
 * Accepts, in order of preference: a browser-plane path, a `/owner/volume`
 * prefixed path, and — only in root mode — a path anchored at `/`.
 *
 * `status` is the caller's to apply, and the two planes deliberately differ: the
 * DAV plane answers `400` for anything it cannot map (matching what the DO has
 * always returned for a bad or cross-origin destination), while the browser
 * plane answers `502 Bad Gateway` for a cross-origin one per RFC 4918 §10.3.
 * `absent` carries `502` as a placeholder the caller must not use — it means
 * there was no header to resolve, which is not an error at all on methods that
 * ignore `Destination`.
 */
function resolveDestination(header: string | null, requestUrl: string, pathBase: string, mode: DavHrefPrefixMode): DestinationResolution {
  if (!header) return { ok: false, reason: 'absent', status: 400 };
  const rawPath = rawPathOf(header);
  if (rawPath !== null && hasDotSegment(rawPath)) return { ok: false, reason: 'invalid', status: 400 };
  let destUrl: URL;
  try {
    destUrl = new URL(header, requestUrl);
  } catch {
    return { ok: false, reason: 'invalid', status: 400 };
  }
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return { ok: false, reason: 'invalid', status: 400 };
  }
  if (destUrl.origin !== origin) return { ok: false, reason: 'cross-origin', status: 400 };
  // A relative `Destination` resolves against the request URL, so this is the
  // first point its inherited segments are inspectable.
  if (hasDotSegment(destUrl.pathname)) return { ok: false, reason: 'invalid', status: 400 };
  const browserInner = browserInnerFrom(destUrl.pathname);
  const inner = browserInner === null ? innerFromPathname(destUrl.pathname, pathBase, mode) : browserInner;
  if (inner === null) return { ok: false, reason: 'invalid', status: 400 };
  return { ok: true, destination: `${origin}${pathBase}${inner === '' ? '/' : `/${inner}`}` };
}

export { resolveDestination };