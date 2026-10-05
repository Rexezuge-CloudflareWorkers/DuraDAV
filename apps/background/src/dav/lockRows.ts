/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
import { normalizeLockDetails, type LockDetails } from '@durable-dav/webdav';

/**
 * One `dav_locks` row → `LockDetails`, or `null` when the row is unusable.
 *
 * Three call sites mapped these seven columns by hand and wrote it slightly
 * differently each time: `DavRepository`'s `lockdiscovery` projection, LOCK's
 * per-path read, and LOCK's refresh lookup. The divergences were small and all
 * in the direction of being *more* lenient — a `root` column that one mapper
 * recomputed and another trusted, a `token` that one coerced through `?? ''`
 * and another read unguarded. A refresh that resolved a different `root` href
 * than the LOCK that created it would report the lock on the wrong resource.
 *
 * The column list and its coercion rules live here so a future `dav_locks`
 * column has one place to be added. Callers that need a different `root` (a
 * `lockdiscovery` href recomputed from the bucket's current base, rather than
 * the value stored at lock time) pass it in; everything else is identical.
 */
function lockDetailsFromRow(row: Record<string, unknown>, root: string): LockDetails | null {
  return normalizeLockDetails({
    token: String(row['token'] ?? ''),
    owner: row['owner'] == null ? undefined : String(row['owner']),
    scope: row['scope'] === 'shared' ? 'shared' : 'exclusive',
    depth: row['depth'] === 'infinity' ? 'infinity' : '0',
    timeout: String(row['timeout'] ?? ''),
    expiresAt: Number(row['expiresAt'] ?? 0),
    root,
  });
}

/**
 * `root` as stored, for the callers that echo the value the LOCK wrote.
 */
function storedLockRoot(row: Record<string, unknown>): string {
  return String(row['root'] ?? '/');
}

/**
 * The columns every lock read needs. Named so the `dav_locks` shape is stated
 * once rather than repeated in three `SELECT` strings that can drift.
 */
const LOCK_COLUMNS = 'token, scope, depth, owner, timeout, expires_at as expiresAt, root';

export { lockDetailsFromRow, storedLockRoot, LOCK_COLUMNS };