import type { KvCache } from '@durable-dav/backend-runtime/kv';
import type { ApiContext } from '@/types/ApiContext';
import type { DavAuthResult } from '@/middleware/DavAuth';
import {
  MAX_CACHED_FILE_BYTES,
  base64ToBytes,
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
200 or 304 built from a cache hit.
*/
function respondFromCache(
  kind: 'file' | 'propfind',
  entry: { etag: string; contentType?: string | null; body?: string; b64?: string },
  request: Request,
  headOnly: boolean,
): Response {
  if (isFresh(request, entry.etag)) {
    // RFC 9110 §15.4.5: a 304 must carry the caching directives it would have
    // sent on a 200, or the client falls back to heuristic freshness.
    return new Response(null, { status: 304, headers: { ETag: entry.etag, 'Cache-Control': cacheControlFor(kind) } });
  }
  if (kind === 'propfind') {
    return new Response(entry.body ?? '', {
      status: 207,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ETag: entry.etag,
        'Cache-Control': cacheControlFor('propfind'),
      },
    });
  }
  const bytes = base64ToBytes(entry.b64 ?? '');
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
      const cached = await getCachedFile(cache, auth.owner, auth.volume, inner);
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
      const cached = await getCachedPropfind(cache, auth.owner, auth.volume, inner, depth, bodyText);
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
  const h = new Headers(c.req.raw.headers);
  h.set('X-Dav-Base', base);
  h.set('X-Dav-Path', inner);
  // Always overwrite, like `X-Dav-User` below: a client-supplied
  // `X-Dav-Href-Prefix-Mode: root` would otherwise reach the DO untouched and
  // silently change the addressing shape of a bucket whose owner chose `base`.
  h.set('X-Dav-Href-Prefix-Mode', auth.hrefPrefixMode);
  // Always overwrite. Setting it only when authenticated let a client-supplied
  // `X-Dav-User: admin@…` through untouched on an anonymous read of a public
  // volume. Nothing consumes it today, but it is a header-injection primitive
  // one refactor away from mattering.
  h.set('X-Dav-User', auth.userEmail ?? '');
  // The DO never reads Authorization; do not hand credentials down.
  h.delete('Authorization');
  return h;
}

export { serveGet, servePropfind, davHeaders };
