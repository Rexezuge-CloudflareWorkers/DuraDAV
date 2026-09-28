import type { KvCache } from '@durable-dav/backend-runtime/kv';
import { DAV_META_TTL_SECONDS } from './DavReadCache';

/**
 * The per-owner volume-list cache.
 *
 * Split out of `DavReadCache` so the key-shape rule below sits next to the
 * three functions that depend on it, rather than inside a file that also owns
 * every DAV read path.
 *
 * ## Why the key is the account id
 *
 * The key used to be the caller's email, which made it unreachable the moment a
 * user changed address: the new address missed, and the old entry sat under a
 * key no invalidation call could name any more — an entry that could neither be
 * read nor evicted, only expired. Keying on the stable account id
 * (`users.id`, migration 0004) means one entry per account stays addressable for
 * its whole TTL, so an invalidation after a change actually lands.
 */

/**
 * Owner segment of the cache key.
 *
 * Lowercased defensively: ids are generated lowercase hex, so this is a no-op
 * for them, but it keeps a caller-supplied fallback key from producing a
 * distinct entry for the same account.
 */
function ownerKeySegment(ownerKey: string): string {
  return ownerKey.toLowerCase();
}

async function invalidateVolumeListCache(cache: KvCache, ownerKey: string): Promise<void> {
  try {
    await cache.del('davMeta', ['volumes', ownerKeySegment(ownerKey)]);
  } catch {
    // Best-effort invalidation.
  }
}

async function getCachedVolumeList<T>(cache: KvCache, ownerKey: string): Promise<T | null> {
  try {
    return await cache.getJson<T>('davMeta', ['volumes', ownerKeySegment(ownerKey)]);
  } catch {
    return null;
  }
}

async function putCachedVolumeList(cache: KvCache, ownerKey: string, value: unknown): Promise<void> {
  try {
    await cache.putJson('davMeta', ['volumes', ownerKeySegment(ownerKey)], value, { ttlSeconds: DAV_META_TTL_SECONDS });
  } catch {
    // Best-effort cache population.
  }
}

export { getCachedVolumeList, invalidateVolumeListCache, putCachedVolumeList };
