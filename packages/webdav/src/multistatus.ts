/**
 * `207 Multi-Status` **response** parser.
 *
 * The module already parses PROPFIND and PROPPATCH *requests* (`xml.ts`); this
 * is the mirror image, and it exists because scheduled replication has to read
 * an arbitrary third-party server's answers rather than our own.
 *
 * Deliberately fail-closed on a malformed body. `parseXmlDocument` returns
 * `null` on any parser error, and this propagates that as `null` rather than
 * guessing: a caller that cannot enumerate the remote must not conclude the
 * remote is empty, because "could not enumerate" and "nothing is here" have
 * opposite consequences — the first must block deletions, the second must
 * trigger them.
 */

import type { Element as XmlElement } from '@xmldom/xmldom';
import { getChildElements, parseXmlDocument } from './xml';
import { etagBody } from './etag';

/**
 * One resource as reported by a `PROPFIND`.
 *
 * `propsComplete` is false when the server returned the resource but no 2xx
 * `propstat` for it — a real shape (every other property 404s) that must stay
 * distinguishable from "the resource is not listed". A server that 404s
 * `getetag` on a file it just listed is normal; a server that omits the
 * resource entirely is a delete.
 */
type RemoteResource = {
  /**
  Raw `DAV:href` as sent, still percent-encoded.
  */
  href: string;
  /**
  `href` resolved against the request URL and percent-decoded per segment.
  */
  pathname: string;
  isCollection: boolean;
  /**
  Unquoted ETag text, or null when absent/unparseable.
  */
  etag: string | null;
  /**
  `getlastmodified` in epoch milliseconds, or null.
  */
  lastModified: number | null;
  /**
  `getcontentlength`, or null. Absent on most collections.
  */
  size: number | null;
  contentType: string | null;
  propsComplete: boolean;
};

type MultiStatusOptions = {
  /**
   * The URL the PROPFIND was sent to. Required, because RFC 4918 §8.3 lets a
   * server return hrefs in any form it likes — `nextcloud` returns absolute
   * paths, some proxies return scheme-relative or relative ones — and a parser
   * that assumed one shape silently mismapped every path in the tree.
   */
  baseUrl: string;
};

/**
 * `HTTP/1.1 200 OK` -> true. Anything unparseable is false.
 *
 * Absent `status` counts as success: RFC 4918 §14.22 makes it required, but
 * real servers omit it, and treating the omitted case as a failure would drop
 * every property those servers do return.
 */
function isSuccessStatus(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  const match = /\s(\d{3})\b/.exec(trimmed);
  if (!match) return false;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code >= 200 && code < 300;
}

function childText(element: XmlElement, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const child of getChildElements(element)) {
    if ((child.localName ?? '').toLowerCase() === wanted) return textOf(child);
  }
  return null;
}

function textOf(element: XmlElement): string {
  let out = '';
  for (let node = element.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4) out += node.nodeValue ?? '';
  }
  return out.trim();
}

function hasChildElement(element: XmlElement, name: string): boolean {
  const wanted = name.toLowerCase();
  return getChildElements(element).some((child) => (child.localName ?? '').toLowerCase() === wanted);
}



function parseSize(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const size = Number(trimmed);
  return Number.isSafeInteger(size) ? size : null;
}

function parseHttpDate(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Percent-decode a URL path one segment at a time.
 *
 * Per segment on purpose: decoding the whole string first would turn an
 * encoded `%2F` inside a filename into a path separator and move the resource.
 * `decodeURIComponent` throws on a malformed escape, and a single bad href from
 * the remote must not abort the parse of an otherwise good listing — the
 * segment is kept verbatim instead.
 */
function decodePathname(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

/**
 * The live properties a sync decision can use, accumulated across every 2xx
 * `propstat` on a response.
 */
type ParsedProps = {
  isCollection: boolean;
  /**
   * Whether `resourcetype` appeared at all — distinct from "is not a collection".
   */
  sawResourcetype: boolean;
  etag: string | null;
  lastModified: number | null;
  size: number | null;
  contentType: string | null;
  propsComplete: boolean;
};

/**
 * One reader per property the planner consumes.
 *
 * A lookup table rather than a `switch` or an `else if` chain: both of those sit
 * inside two nested loops here, and the lint rules for those shapes fight each
 * other (one wants a `switch`, the other rejects `break` in a nested loop). A
 * table sidesteps both and reads as the declaration it is.
 */
const PROPERTY_READERS: Readonly<Record<string, (property: XmlElement, into: ParsedProps) => void>> = {
  resourcetype: (property, into) => {
    into.sawResourcetype = true;
    into.isCollection = hasChildElement(property, 'collection');
  },
  getetag: (property, into) => {
    into.etag = etagBody(textOf(property));
  },
  getlastmodified: (property, into) => {
    into.lastModified = parseHttpDate(textOf(property));
  },
  getcontentlength: (property, into) => {
    into.size = parseSize(textOf(property));
  },
  getcontenttype: (property, into) => {
    const value = textOf(property);
    into.contentType = value === '' ? null : value;
  },
};

/**
 * Merge every 2xx `propstat` on one `DAV:response`.
 *
 * Split out of `readResource` so the loop nesting stops at one level, and so the
 * merge reads as the single unit it is.
 */
function readProps(response: XmlElement): ParsedProps {
  const into: ParsedProps = {
    isCollection: false,
    sawResourcetype: false,
    etag: null,
    lastModified: null,
    size: null,
    contentType: null,
    propsComplete: false,
  };
  for (const propstat of getChildElements(response)) {
    const isPropstat = (propstat.localName ?? '').toLowerCase() === 'propstat';
    if (!isPropstat || !isSuccessStatus(childText(propstat, 'status') ?? '')) continue;
    const prop = getChildElements(propstat).find((child) => (child.localName ?? '').toLowerCase() === 'prop');
    if (prop === undefined) continue;
    into.propsComplete = true;
    for (const property of getChildElements(prop)) {
      // Namespace-blind on purpose: `getetag` in a foreign namespace is not
      // `DAV:getetag`, but rejecting on the namespace would make every
      // non-conforming server unlistable rather than merely imprecise. Dead
      // properties have no reader and are skipped, which is the point.
      PROPERTY_READERS[(property.localName ?? '').toLowerCase()]?.(property, into);
    }
  }
  return into;
}

/**
 * One `DAV:response`, or null when it carries no usable href.
 */
function readResource(response: XmlElement, baseUrl: string): RemoteResource | null {
  const href = childText(response, 'href');
  if (href === null || href === '') return null;
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return null;
  }
  const props = readProps(response);
  return {
    href,
    pathname: decodePathname(resolved.pathname),
    // Absent `resourcetype` is not a collection. Defaulting to `true` because the
    // href ended in `/` would make a server that omits the property issue `MKCOL`
    // over its own files.
    isCollection: props.sawResourcetype && props.isCollection,
    etag: props.etag,
    lastModified: props.lastModified,
    size: props.size,
    contentType: props.contentType,
    propsComplete: props.propsComplete,
  };
}

/**
 * Parse a `207 Multi-Status` body.
 *
 * Returns `null` for anything that is not a usable multistatus: a non-DAV body,
 * an XML parse error, or a document whose root is not `multistatus`. Callers
 * must treat `null` as "listing failed", never as "listing was empty".
 */
function parseMultiStatus(body: string, options: MultiStatusOptions): RemoteResource[] | null {
  const document = parseXmlDocument(body);
  const root = document?.documentElement;
  if (root === null || root === undefined || (root.localName ?? '').toLowerCase() !== 'multistatus') return null;
  const responses = getChildElements(root);
  return responses
    .filter((response) => (response.localName ?? '').toLowerCase() === 'response')
    .map((response) => readResource(response, options.baseUrl))
    .filter((resource): resource is RemoteResource => resource !== null);
}

export { parseMultiStatus, isSuccessStatus, decodePathname };
export type { RemoteResource, MultiStatusOptions };
