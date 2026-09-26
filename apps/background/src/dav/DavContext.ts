import { stripSlashes } from '@durable-dav/webdav';
import { readDavHrefPrefixMode } from '@durable-dav/shared/constants';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';

// Pure path helpers shared by every WebDAV method handler (why: the DO
// previously duplicated `fsPathOf`/`hrefOf`/base-stripping inline, which hid
// traversal edge cases and made unit testing impossible).

/**
 * The two prefixes a volume request carries, which are not the same thing.
 *
 * `pathBase` is the volume's real public prefix (`/owner/volume`). It is
 * addressing: request-URL resolution (`resolveInnerPath`) and `Destination`
 * mapping (`stripBase`) both need it, and it is the same for every bucket.
 *
 * `hrefBase` is what `DAV:href` values are anchored to, and a bucket may opt
 * out of carrying the base — see `resolveDavBases`. `''` means "anchor at the
 * root", which the `hrefOf`/`getResourceHref` builders already implement.
 *
 * These were one `base` parameter and had to be split: a single string cannot
 * both resolve the request URL and describe the href shape a `root`-mode
 * bucket should advertise. Threading one object rather than two strings means
 * every call site has to name both, so a new handler cannot silently pick the
 * wrong one for addressing.
 */
interface DavBases {
  pathBase: string;
  hrefBase: string;
}

/**
 * Maximum segments in a volume-relative path. Bounds the ancestor walks in
 * `DavLockGuard` and `getParentPath` callers, so a pathological deep path
 * cannot drive an unbounded SQL/statement loop.
 */
const MAX_PATH_DEPTH = 256;

function fsPathOf(innerPath: string): string {
  return innerPath === '' ? '/' : `/${innerPath}`;
}

function hrefOf(base: string, innerPath: string, isCollection: boolean): string {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  if (innerPath === '') return `${prefix}/`;
  return `${prefix}/${innerPath.split('/').map(encodeURIComponent).join('/')}${isCollection ? '/' : ''}`;
}

/**
 * Derive both bases from the front door's two headers.
 *
 * `X-Dav-Href-Prefix-Mode` is optional and defaults to `base`, so a request
 * from an older front door — or a direct DO call — keeps the href shape every
 * existing client already works with. An unrecognised mode takes the same
 * default rather than failing the request: the value can only be wrong through
 * version skew, and the conforming shape is the safe answer to that.
 */
function resolveDavBases(pathBase: string, hrefPrefixMode: string | null | undefined): DavBases {
  const mode: DavHrefPrefixMode = readDavHrefPrefixMode(hrefPrefixMode);
  return { pathBase, hrefBase: mode === 'root' ? '' : pathBase };
}

/**
Reject `.`/`..`/empty segments so encoded traversal can never escape the volume root,
and cap the depth (see `MAX_PATH_DEPTH`).
*/
function isValidInnerPath(innerPath: string): boolean {
  if (innerPath === '') return true;
  const segments = innerPath.split('/');
  return segments.length <= MAX_PATH_DEPTH && segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

function decodeSegments(path: string): string {
  try {
    return path
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    return path;
  }
}

/**
 * Resolve the volume-relative path for a DO request.
 * Prefers the front-door `X-Dav-Path` header; falls back to stripping the
 * `/owner/volume` base prefix from the URL pathname.
 *
 * Both sources are percent-decoded so encoded traversal (`%2e%2e`) is
 * rejected by `isValidInnerPath` instead of slipping into `dofs` as an
 * opaque segment.
 *
 * Returns `null` when the URL has no `/owner/volume` prefix to strip. The
 * previous shape returned `''` — the volume root — for anything with fewer
 * than three segments, so a malformed direct DO request silently operated on
 * the bucket root instead of being rejected. Callers must answer `400`.
 */
function resolveInnerPath(request: Request, url: URL, base: string): string | null {
  const header = request.headers.get('X-Dav-Path');
  if (header !== null) return decodeSegments(stripSlashes(header));
  const pathname = url.pathname;
  if (base !== '' && pathname.startsWith(base)) {
    return decodeSegments(stripSlashes(pathname.slice(base.length)));
  }
  const parts = stripSlashes(pathname).split('/');
  return parts.length > 2 ? decodeSegments(parts.slice(2).join('/')) : null;
}

/**
 * Map a full decoded destination path (incl. `/owner/volume` prefix) back to
 * a volume-relative path. Returns `null` when the destination does not name
 * this volume.
 *
 * Base matching is case-insensitive (why: volume keys are lowercased at the
 * front door, but `Destination` headers may preserve original casing).
 *
 * A path with no `/` at all is rejected rather than treated as volume-relative.
 * The WHATWG URL parser resolves `Destination` against the request URL and
 * *does* normalise `%2e%2e`, so
 * `https://host/test/vol/%2e%2e/%2e%2e/etc` arrives here as the bare string
 * `etc`. The old fallback returned it as a member of the current volume, so an
 * attempt to escape upwards silently became a successful write to
 * `vol/etc` and a `201`. A legitimately relative `Destination` cannot reach
 * this branch: `new URL(dest, requestUrl)` already resolves it against the
 * request URL, so it arrives with the base prefix intact.
 */
function stripBase(full: string, base: string): string | null {
  const baseTrim = stripSlashes(base);
  const fullLower = full.toLowerCase();
  const baseLower = baseTrim.toLowerCase();
  if (fullLower === baseLower) return '';
  if (baseTrim === '') return full;
  if (fullLower.startsWith(`${baseLower}/`)) return full.slice(baseTrim.length + 1);
  const parts = full.split('/');
  return parts.length >= 2 && `${parts[0]}/${parts[1]}`.toLowerCase() === baseLower ? parts.slice(2).join('/') : null;
}

export { MAX_PATH_DEPTH, fsPathOf, hrefOf, isValidInnerPath, resolveInnerPath, stripBase, resolveDavBases };
export type { DavBases };
