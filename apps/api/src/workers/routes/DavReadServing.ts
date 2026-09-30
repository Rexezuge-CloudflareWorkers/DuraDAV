import type { KvCache } from '@durable-dav/backend-runtime/kv';
import type { ApiContext } from '@/types/ApiContext';
import type { DavAuthResult } from '@/middleware/DavAuth';
import { applyDavForwardHeaders } from './davForwardHeaders';
import {
  MAX_CACHED_FILE_BYTES,
  base64ToBytes,
  bytesToBase64,
  cacheControlFor,
  etagForPropfind,
  getCachedFile,
  getCachedPropfind,
  hashBody,
  isFresh,
  putCachedFile,
  putCachedPropfind,
} from './DavReadCache';

type DavContext = ApiContext;

/**
 * Response construction for cached DAV reads.
 *
 * `GET`/`HEAD` and `PROPFIND` share the same five steps — resolve cache, decide
 * freshness, forward to the DO, populate the cache, build the response — and
 * previously each reimplemented them, writing the 200 header block three times
 * and the 304 block twice with subtly different field sets. That duplication is
 * what let the 304 arm omit the `Cache-Control` its 200 counterpart sent.
 *
 * One builder per response shape keeps 200/304/Content-Length/ETag in lock-step.
 */

/**
 * Coerce a raw KV value into a `propfind` cache entry, or `null` if it is not
 * one.
 *
 * A miss is the correct answer to anything unrecognised. The `?? ''` shape this
 * replaces served `200 Content-Length: 0` for a file the client can see in a
 * listing, and an *empty* multistatus for a collection — which reads as "this
 * folder is empty" rather than as the cache miss it is. An entry is only
 * usable if the field it is keyed on is present and a string; the optional ones
 * degrade to their defaults.
 */
function asPropfindEntry(raw: unknown): { etag: string; body: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as { etag?: unknown; body?: unknown };
  return typeof entry.etag !== 'string' || entry.etag === '' || (typeof entry.body !== 'string') ? null : { etag: entry.etag, body: entry.body };
}

/**
 * `file` counterpart of {@link asPropfindEntry}.
 *
 * `b64` is validated by round-tripping rather than by shape: an entry whose
 * base64 does not decode is unusable, and `atob` throwing here turns a bad
 * entry into a miss instead of a 500.
 */
function asFileEntry(raw: unknown): { etag: string; contentType?: string | null; b64: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as { etag?: unknown; contentType?: unknown; b64?: unknown };
  if (typeof entry.etag !== 'string' || entry.etag === '' || (typeof entry.b64 !== 'string')) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(entry.b64);
  } catch {
    // Not decodable base64. Treated as a miss rather than letting `atob`'s
    // throw escape as a 500 on the read path.
    return null;
  }
  return {
    etag: entry.etag,
    contentType: typeof entry.contentType === 'string' ? entry.contentType : null,
    // Re-encoded so the decoded and stored forms cannot disagree, and so the
    // caller never holds both at once.
    b64: bytesToBase64(bytes),
  };
}

/**
200 or 304 built from a cache hit.
*/
function respondFromCache(
  kind: 'file' | 'propfind',
  entry: { etag: string; contentType?: string | null; body: string } | { etag: string; contentType?: string | null; b64: string },
  request: Request,
  headOnly: boolean,
): Response {
  if (isFresh(request, entry.etag)) {
    // RFC 9110 §15.4.5: a 304 must carry the caching directives it would have
    // sent on a 200, or the client falls back to heuristic freshness.
    return new Response(null, { status: 304, headers: { ETag: entry.etag, 'Cache-Control': cacheControlFor(kind) } });
  }
  if (kind === 'propfind') {
    const body = 'body' in entry ? entry.body : '';
    return new Response(body, {
      status: 207,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ETag: entry.etag,
        'Cache-Control': cacheControlFor('propfind'),
      },
    });
  }
  const b64 = 'b64' in entry ? entry.b64 : '';
  const bytes = base64ToBytes(b64);
  return new Response(headOnly ? null : (bytes as BodyInit), {
    status: 200,
    headers: {
      'Content-Type': entry.contentType ?? 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      ETag: entry.etag,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControlFor('file'),
    },
  });
}

/**
200/304 for a body already materialised from the DO.
*/
function respondFromBytes(
  kind: 'file' | 'propfind',
  status: 200 | 207,
  body: ArrayBuffer | string,
  etag: string,
  extra: Record<string, string>,
  request: Request,
  headOnly: boolean,
): Response {
  if (isFresh(request, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControlFor(kind) } });
  }
  const length = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
  return new Response(headOnly ? null : (body as BodyInit), {
    status,
    headers: {
      'Content-Type': kind === 'propfind' ? 'application/xml; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(length),
      ETag: etag,
      'Cache-Control': cacheControlFor(kind),
      ...extra,
    },
  });
}

interface ServeReadArgs {
  c: DavContext;
  stub: { fetch: (request: Request) => Promise<Response> };
  auth: DavAuthResult;
  base: string;
  inner: string;
  cache: KvCache;
  headOnly: boolean;
  /**
  Resolved from `DAV_CACHE_TTL_SECONDS`.
  */
  ttls: { prop: number; file: number };
}

/**
 * `GET`/`HEAD` with a KV-cached small-file body.
 *
 * Range slices bypass the cache (per-request offsets, and `dofs.read` needs
 * them). HTML collection listings are never cached.
 */
async function serveGet(args: ServeReadArgs): Promise<Response> {
  const { c, stub, auth, inner, cache, headOnly, ttls } = args;
  const hasRange = c.req.raw.headers.has('Range');
  if (!hasRange) {
    try {
      const cached = asFileEntry(await getCachedFile(cache, auth.owner, auth.volume, inner));
      if (cached) return respondFromCache('file', cached, c.req.raw, headOnly);
    } catch {
      // Fail-soft: fall through to the DO loader.
    }
  }
  const forward = new Request(c.req.url, { method: headOnly ? 'HEAD' : 'GET', headers: davHeaders(c, auth, args.base, inner) });
  const response = await stub.fetch(forward);
  if (headOnly || hasRange || response.status !== 200) return response;
  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  const etag = response.headers.get('ETag');
  if (!etag || contentType.includes('text/html')) return response;
  // Consume defensively. A failure here must not leave us trying to re-use an
  // already-locked body stream, which threw a TypeError and surfaced as a 500
  // through the catch's "fall through with the original response".
  const buf = await response.arrayBuffer().catch(() => null);
  if (!buf) return response;
  if (buf.byteLength <= MAX_CACHED_FILE_BYTES) {
    await putCachedFile(cache, auth.owner, auth.volume, inner, new Uint8Array(buf), contentType, etag, ttls.file).catch(() => undefined);
  }
  // Build an explicit header set: `buf` is the runtime-*decoded* body, so
  // cloning the DO's headers verbatim could carry a now-wrong `Content-Length`,
  // a stale `Content-Encoding`, or hop-by-hop headers.
  return respondFromBytes('file', 200, buf, etag, { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }, c.req.raw, headOnly);
}

/**
 * `PROPFIND` with a KV-cached multistatus body.
 *
 * Only `Depth: 0`/`1` are cached; an infinity walk can exceed KV limits.
 */
async function servePropfind(args: Omit<ServeReadArgs, 'headOnly'>): Promise<Response> {
  const { c, stub, auth, inner, cache, ttls } = args;
  const depth = c.req.raw.headers.get('Depth') ?? 'infinity';
  const cacheable = depth === '0' || depth === '1';
  // Read once as bytes: `c.req.text()` decoded as UTF-8 and re-encoding it
  // corrupted any non-UTF-8 XML body, and the same buffer feeds the cache key.
  const bodyBytes = await c.req.arrayBuffer().catch(() => new ArrayBuffer(0));
  const bodyText = new TextDecoder().decode(bodyBytes);
  if (cacheable) {
    try {
      const cached = asPropfindEntry(await getCachedPropfind(cache, auth.owner, auth.volume, inner, depth, bodyText));
      if (cached) return respondFromCache('propfind', cached, c.req.raw, false);
    } catch {
      // Fail-soft: fall through to the DO loader.
    }
  }
  const forward = new Request(c.req.url, {
    method: 'PROPFIND',
    headers: davHeaders(c, auth, args.base, inner),
    body: bodyBytes.byteLength > 0 ? bodyBytes : undefined,
    duplex: 'half',
  } as RequestInit);
  const response = await stub.fetch(forward);
  if (!cacheable || response.status !== 207) return response;
  const text = await response.text().catch(() => null);
  if (text === null) return response;
  const etag =
    response.headers.get('ETag') ?? etagForPropfind(`${auth.owner}/${auth.volume}`.toLowerCase(), inner, depth, hashBody(bodyText));
  await putCachedPropfind(cache, auth.owner, auth.volume, inner, depth, bodyText, { body: text, etag }, ttls.prop).catch(() => undefined);
  return respondFromBytes('propfind', 207, text, etag, {}, c.req.raw, false);
}

/**
 * Header set the DO receives.
 *
 * `X-Dav-Base` (the real `/owner/volume` prefix) and `X-Dav-Href-Prefix-Mode`
 * (how hrefs should be anchored) are separate headers on purpose: the first
 * drives request addressing, the second only presentation. Conflating them
 * would make a `root`-mode bucket unable to resolve its own request URL.
 */
function davHeaders(c: DavContext, auth: DavAuthResult, base: string, inner: string): Headers {
  return applyDavForwardHeaders(c.req.raw.headers, {
    base,
    inner,
    hrefPrefixMode: auth.hrefPrefixMode,
    userEmail: auth.userEmail,
    // The WebDAV plane never pages: RFC 4918 §9.1 has no paging concept, so a
    // paged 207 here would be a truncated multistatus to a native client.
  });
}

// `asPropfindEntry`/`asFileEntry` are exported for direct unit testing: they are
// the fail-closed boundary between "whatever is in KV" and "what we serve", and
// a bug there is a wrong body rather than an exception, which no other test in
// the suite would notice.
export { serveGet, servePropfind, davHeaders, asPropfindEntry, asFileEntry };
