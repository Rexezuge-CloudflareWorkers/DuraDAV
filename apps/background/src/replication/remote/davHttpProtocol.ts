import { RemoteUrlRejectedError } from '@durable-dav/shared/net';
import { bytesToBase64 } from '@durable-dav/shared/utils';
import { stripSlashes as trimSlashes } from '@durable-dav/webdav';

/**
 * URL and body helpers for the WebDAV transport.
 *
 * Free functions rather than private methods, because each one is a rule worth
 * reading on its own — and two of them exist specifically to prevent a class of
 * bug that is very hard to spot from the call site.
 */

type DavHttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

type DavAuthHeader = { kind: 'none' } | { kind: 'basic'; value: string } | { kind: 'bearer'; token: string };

/**
Directories walked concurrently during a recursive delete.
*/
const DELETE_FANOUT = 8;

/**
 * Hard ceiling on recursive-delete depth.
 *
 * Matches the longest inner path the DO accepts rather than being an arbitrary
 * round number: past this the target is misbehaving, not deep.
 */
const MAX_REMOVE_DEPTH = 64;

/**
 * Statuses that mean the resource is gone.
 *
 * `404` counts: a repeated pass over an already-deleted path must be idempotent,
 * not an error.
 */
const DELETE_SUCCESS: ReadonlySet<number> = new Set([200, 204, 404]);

/**
 * Join the configured base and subdirectory into a URL.
 *
 * `encodeURI` per segment rather than one pass over the whole string: a `%2F`
 * inside a segment must stay encoded, and a single encode would turn it into a
 * separator and address a different resource.
 */
function joinUrl(base: string, ...segments: string[]): string {
  const encoded = segments
    .map((segment) => trimSlashes(segment))
    .filter((segment) => segment !== '')
    .map((segment) => segment.split('/').map(encodeURIComponent).join('/'));
  const path = encoded.join('/');
  const baseTrimmed = base.endsWith('/') ? base : `${base}/`;
  return path === '' ? baseTrimmed : `${baseTrimmed}${path}`;
}

/**
 * Map a multistatus entry onto an inner path.
 *
 * Returns null for the entry that *is* the requested collection: it is not a child
 * of itself, and including it would make every listing report its own directory as
 * a new file to push.
 */
function toInnerEntry(pathname: string, rootPathname: string): { inner: string; href: string } | null {
  if (!pathname.startsWith(rootPathname)) return null;
  const remainder = pathname.slice(rootPathname.length).replace(/^\/+/, '');
  if (remainder === '') return null;
  // Reject a path that climbed above the root via `..` or an encoded separator.
  // `decodeURIComponent` already ran per segment, so a `%2F` is a literal character
  // in a name here and cannot produce this — but `..` can, and a replication that
  // writes outside its configured subdirectory is exactly the failure this guards.
  return remainder.split('/').some((segment) => segment === '..' || segment === '.') ? null : { inner: remainder, href: pathname };
}

/**
 * Depth-1 PROPFIND asking for exactly the properties the planner compares.
 *
 * `allprop` would be simpler and is wrong: servers return whatever they feel like,
 * so the parser would have to defend against properties this code has no meaning
 * for — and some servers answer `allprop` with the full dead-property set, which for
 * a large tree is a response an order of magnitude larger than the four numbers the
 * decision needs.
 */
function propfindBody(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/></d:prop></d:propfind>`;
}

function classifyStatus(status: number, method: string, path: string): string {
  return `${method} ${path} failed with ${status}`;
}

/**
 * Basic auth header value, base64 of `user:password`.
 *
 * RFC 7617 forbids a colon in the user half, and several servers silently truncate
 * at the first one — so a password containing a colon is rejected here rather than
 * producing a target that authenticates as the wrong user.
 */
function basicAuthValue(username: string, password: string): string {
  if (username.includes(':')) {
    throw new RemoteUrlRejectedError('replication username must not contain a colon');
  }
  // The shared codec rather than the `String.fromCodePoint` + `btoa` form this
  // used to build — a third copy of the accumulation `Base64.ts` documents as
  // allocating ~2× the input as UTF-16.
  return bytesToBase64(new TextEncoder().encode(`${username}:${password}`));
}

export {
  joinUrl,
  toInnerEntry,
  propfindBody,
  classifyStatus,
  basicAuthValue,
  
  DELETE_FANOUT,
  MAX_REMOVE_DEPTH,
  DELETE_SUCCESS,
};
export type { DavHttpFetch, DavAuthHeader };

export {stripSlashes as trimSlashes} from '@durable-dav/webdav';