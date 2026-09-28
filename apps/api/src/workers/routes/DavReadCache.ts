import type { KvCache } from '@durable-dav/backend-runtime/kv';
import { digest128 } from '@durable-dav/backend-runtime/kv';
import { normalizeVolumeKey } from '@durable-dav/webdav';

// KV-backed read cache for DAV RPCs (Git `RepoReadCache` pattern).
// D1/DO stay authoritative; KV is loss-tolerant. All keys use the canonical
// lowercase volume key so `Foo/Bar` and `foo/bar` share one entry, matching
// `DAV_VOLUME.getByName` sharding. PROPFIND snapshots live 120s (`davProp`
// domain) and are invalidated on write; small file bodies live 300s
// (`davFile` domain) keyed by volume+path; the per-owner volume *list*
// snapshot lives 60s (`davMeta` domain) keyed by owner email. There is no
// per-volume detail snapshot — `VolumeDetail` reads the row its ownership
// guard already loaded.

// Per-kind TTLs. `DAV_CACHE_TTL_SECONDS` scales the two content caches
// together; the metadata snapshot is deliberately independent because it backs
// the dashboard list, where staleness is user-visible.
const DEFAULT_PROP_TTL_SECONDS = 120;
const DEFAULT_FILE_TTL_SECONDS = 300;
const DAV_META_TTL_SECONDS = 60;

/**
 * Resolve the configured content-cache TTLs.
 *
 * `DAV_CACHE_TTL_SECONDS` was present in the wrangler template with
 * `AppConfiguration.getDavCacheTtlSeconds()` implemented, and nothing ever
 * called it — so tuning the variable had no effect at all. Now wired, with the
 * template's 300s as the default.
 */
function contentTtls(configuredSeconds: number | null | undefined): { prop: number; file: number } {
  const base =
    configuredSeconds !== null && configuredSeconds !== undefined && configuredSeconds > 0 ? configuredSeconds : DEFAULT_FILE_TTL_SECONDS;
  // PROPFIND snapshots are cheaper to rebuild than file bodies are to re-read,
  // so they never outlive half the file TTL.
  return { prop: Math.max(1, Math.floor(base / 2.5)), file: Math.floor(base) };
}
// Upper bound for KV-cached file bodies (raw bytes). `davFile` caps at
// 1MiB; base64 inflates ~33%, so only small responses are cached.
// Large files bypass the cache and always hit the DO.
const MAX_CACHED_FILE_BYTES = 700_000;

/**
 * Longest inner path the KV cache will key on.
 *
 * `buildKvKey` falls back to a digest when a key exceeds the platform's
 * 512-character limit, and a digested key no longer starts with
 * `<domain>:<version>:<volume>` — so `purgePrefix` on a volume would never
 * match it and the entry would keep serving pre-write bytes for its full TTL.
 * Refusing to cache long paths keeps every key purgeable; long-path files are
 * cold anyway.
 */
const MAX_CACHEABLE_PATH_LENGTH = 200;

function isCacheablePath(inner: string): boolean {
  return inner.length <= MAX_CACHEABLE_PATH_LENGTH;
}

/**
 * DAV methods that can change volume content, and therefore must drop the
 * volume's read-cache entries.
 *
 * This is an explicit allow-list rather than "everything that isn't a read".
 * The complement form (`!['GET','HEAD','OPTIONS','PROPFIND'].includes(m)`) also
 * matched `LOCK`/`UNLOCK`, which most clients send around every operation —
 * each one triggering two `purgePrefix` sweeps (10 list pages + up to 10 000
 * deletes per domain), which effectively disabled the cache for real clients
 * while still paying full price. New methods are read-only until added here.
 */
const CONTENT_INVALIDATING_METHODS: ReadonlySet<string> = new Set(['PUT', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'PROPPATCH']);

function invalidatesReadCache(method: string): boolean {
  return CONTENT_INVALIDATING_METHODS.has(method);
}

function cacheKeyForVolume(owner: string, volume: string): string {
  return normalizeVolumeKey(owner, volume);
}

function isFresh(request: Request, etag: string | null): boolean {
  if (!etag) return false;
  const incoming = request.headers.get('If-None-Match');
  return incoming ? incoming.split(',').some((part) => part.trim() === etag || part.trim() === '*') : false;
}

function cacheControlFor(kind: string): string {
  if (kind === 'file') return 'private, max-age=300, must-revalidate';
  return kind === 'propfind' ? 'private, max-age=60, must-revalidate' : 'private, max-age=30, must-revalidate';
}

function withEtagHeaders(response: Response, etag: string, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set('ETag', etag);
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

function hashBody(value: string): string {
  return digest128(value);
}

function propfindCacheParts(volumeKey: string, innerPath: string, depth: string, body: string): readonly string[] {
  return [volumeKey, `path:${innerPath}`, `depth:${depth}`, hashBody(body)];
}

function fileCacheParts(volumeKey: string, innerPath: string): readonly string[] {
  return [volumeKey, `path:${innerPath}`];
}

interface CachedPropfind {
  body: string;
  etag: string;
}

interface CachedFile {
  b64: string;
  contentType: string;
  etag: string;
}

function etagForPropfind(volumeKey: string, innerPath: string, depth: string, bodyHash: string): string {
  return `W/"prop-${digest128(`${volumeKey}:${innerPath}:${depth}:${bodyHash}`)}"`;
}

async function getCachedPropfind(
  cache: KvCache,
  owner: string,
  volume: string,
  innerPath: string,
  depth: string,
  body: string,
): Promise<CachedPropfind | null> {
  if (!isCacheablePath(innerPath)) return null;
  try {
    return await cache.getJson<CachedPropfind>('davProp', propfindCacheParts(cacheKeyForVolume(owner, volume), innerPath, depth, body));
  } catch {
    return null;
  }
}

async function putCachedPropfind(
  cache: KvCache,
  owner: string,
  volume: string,
  innerPath: string,
  depth: string,
  body: string,
  entry: CachedPropfind,
  ttlSeconds: number = DEFAULT_PROP_TTL_SECONDS,
): Promise<void> {
  if (!isCacheablePath(innerPath)) return;
  try {
    await cache.putJson('davProp', propfindCacheParts(cacheKeyForVolume(owner, volume), innerPath, depth, body), entry, {
      ttlSeconds,
    });
  } catch {
    // Best-effort cache population.
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = (binary.codePointAt(i) ?? 0) & 0xff;
  return out;
}

async function getCachedFile(cache: KvCache, owner: string, volume: string, innerPath: string): Promise<CachedFile | null> {
  if (!isCacheablePath(innerPath)) return null;
  try {
    return await cache.getJson<CachedFile>('davFile', fileCacheParts(cacheKeyForVolume(owner, volume), innerPath));
  } catch {
    return null;
  }
}

async function putCachedFile(
  cache: KvCache,
  owner: string,
  volume: string,
  innerPath: string,
  bytes: Uint8Array,
  contentType: string,
  etag: string,
  ttlSeconds: number = DEFAULT_FILE_TTL_SECONDS,
): Promise<void> {
  // Every key must stay purgeable by volume prefix — see
  // `MAX_CACHEABLE_PATH_LENGTH`.
  if (!isCacheablePath(innerPath)) return;
  if (bytes.byteLength > MAX_CACHED_FILE_BYTES) return;
  try {
    await cache.putJson(
      'davFile',
      fileCacheParts(cacheKeyForVolume(owner, volume), innerPath),
      { b64: bytesToBase64(bytes), contentType, etag } satisfies CachedFile,
      { ttlSeconds },
    );
  } catch {
    // Best-effort cache population.
  }
}

async function invalidateVolumeCaches(cache: KvCache, owner: string, volume: string): Promise<void> {
  const key = cacheKeyForVolume(owner, volume);
  try {
    await cache.purgePrefix('davProp', [key]);
  } catch {
    // Best-effort invalidation.
  }
  try {
    await cache.purgePrefix('davFile', [key]);
  } catch {
    // Best-effort invalidation.
  }
  // No `davMeta` sweep: the per-volume *detail* snapshot this used to drop is
  // gone — `VolumeDetail` serves straight from the row its ownership guard
  // already loaded, because the guard had to read D1 anyway and so the cache
  // could never skip the query it existed for (see `VolumeRoutes`). The delete
  // outlived the write and matched nothing, but the free plan meters a delete
  // against a key that does not exist exactly like one that does, so every
  // content-mutating DAV request was spending a unit of the 1,000/day budget on
  // a guaranteed miss. `davMeta` now holds only the per-owner volume *list`,
  // which is keyed on the owner rather than the volume and is invalidated by
  // `invalidateVolumeListCache` instead.
}

// The per-owner volume list lives in `DavVolumeListCache`: it is keyed on the
// account id (migration 0004) rather than the caller's address, and the reason
// is explained there.
export { getCachedVolumeList, invalidateVolumeListCache, putCachedVolumeList } from './DavVolumeListCache';

export {
  DAV_META_TTL_SECONDS,
  DEFAULT_PROP_TTL_SECONDS,
  DEFAULT_FILE_TTL_SECONDS,
  MAX_CACHED_FILE_BYTES,
  cacheKeyForVolume,
  isFresh,
  cacheControlFor,
  withEtagHeaders,
  hashBody,
  etagForPropfind,
  getCachedPropfind,
  putCachedPropfind,
  getCachedFile,
  putCachedFile,
  invalidateVolumeCaches,
  bytesToBase64,
  base64ToBytes,
  invalidatesReadCache,
  isCacheablePath,
  contentTtls,
};
export type { CachedPropfind, CachedFile };
