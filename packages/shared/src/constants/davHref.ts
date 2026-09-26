/**
 * How `DAV:href` values are anchored, per bucket.
 *
 * RFC 4918 §8.3 requires every `DAV:href` to be a URI reference that resolves
 * against the *request* URL, so the conforming form carries the volume's
 * `/owner/volume` base (`/alice/photos/dir/file.txt`). Omitting it produces
 * `/dir/file.txt`, which third-party clients resolve against the request URL and
 * land outside the volume — a 404 for every entry.
 *
 * A minority of clients nonetheless expect the volume root to be `/`. They
 * cannot be argued out of it, so the choice is per bucket rather than global:
 * `root` emits `/dir/file.txt` for those buckets only.
 *
 * The mode is *presentational only*. It never changes request addressing
 * (`X-Dav-Base` still carries the real base), `Destination` canonicalisation,
 * or any stored path — `getResourceHref`/`hrefOf` already emit root-relative
 * hrefs when handed an empty base, so the whole feature is "which string do we
 * hand the href builders".
 *
 * Layer 0 so the DAO, the service layer, the front door, and the DO can all
 * agree on the vocabulary without importing each other.
 */

const DAV_HREF_PREFIX_MODES = ['base', 'root'] as const;

type DavHrefPrefixMode = (typeof DAV_HREF_PREFIX_MODES)[number];

/**
 * What a bucket gets when nothing says otherwise. The RFC-conforming form: a
 * wrong default breaks conforming clients everywhere, whereas a wrong opt-in
 * only affects the bucket that asked for it.
 */
const DEFAULT_DAV_HREF_PREFIX_MODE: DavHrefPrefixMode = 'base';

function isDavHrefPrefixMode(value: unknown): value is DavHrefPrefixMode {
  return value === 'base' || value === 'root';
}

/**
 * Strict parse for untrusted input (API bodies, D1 rows that predate the
 * column). Returns `null` for anything else so the caller can answer `400`
 * rather than silently storing a mode the server cannot honour.
 */
function toDavHrefPrefixMode(value: unknown): DavHrefPrefixMode | null {
  return isDavHrefPrefixMode(value) ? value : null;
}

/**
 * Lenient parse for the internal DO header, where an absent or unrecognised
 * value must not fail the request: the front door always sets it, so an
 * unexpected value can only mean a version skew, and the safe answer to that is
 * the behaviour every existing client already works with.
 */
function readDavHrefPrefixMode(value: string | null | undefined): DavHrefPrefixMode {
  return isDavHrefPrefixMode(value) ? value : DEFAULT_DAV_HREF_PREFIX_MODE;
}

export {
  DAV_HREF_PREFIX_MODES,
  DEFAULT_DAV_HREF_PREFIX_MODE,
  isDavHrefPrefixMode,
  toDavHrefPrefixMode,
  readDavHrefPrefixMode,
};
export type { DavHrefPrefixMode };
