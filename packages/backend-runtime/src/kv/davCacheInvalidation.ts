// Volume-scoped invalidation for the DAV read caches.
//
// This lives in `backend-runtime` rather than next to `DavReadCache` in
// `apps/api` because a second writer exists now: scheduled replication mutates
// bucket content from inside `apps/background`, which has no way to import an
// `apps/api` module. The failure it prevents is not subtle — `DavReadCache`
// serves PROPFIND snapshots and small file bodies from KV, keyed on volume and
// path, and is invalidated today *only* by the front-door methods listed in
// `CONTENT_INVALIDATING_METHODS`. A write that lands by any other route leaves
// a pre-write body readable for the rest of the TTL, which for a synced bucket
// means serving content the owner already replaced on the other side.
//
// Two calls, not three: `davMeta` holds the per-owner volume *list*, which is
// keyed on the owner rather than the volume and is invalidated separately by
// `invalidateVolumeListCache`. Sweeping it here would cost a delete against
// every owner on the deployment on every replicated write.

import type { KvCache } from './KvCache';

const DAV_CONTENT_DOMAINS = ['davProp', 'davFile'] as const;

/**
 * Drop every cached read for one volume. Best-effort by design: KV is a
 * loss-tolerant optimization, so a purge failure must not fail the write that
 * triggered it. The cost of skipping it is bounded by the TTL.
 */
async function invalidateDavVolumeCaches(cache: KvCache, volumeKey: string): Promise<void> {
  for (const domain of DAV_CONTENT_DOMAINS) {
    try {
      await cache.purgePrefix(domain, [volumeKey]);
    } catch {
      // Best-effort invalidation; see above.
    }
  }
}

export { invalidateDavVolumeCaches, DAV_CONTENT_DOMAINS };
