/**
 * Per-path sync base, stored in the volume Durable Object's own SQLite.
 *
 * ## Why this exists at all
 *
 * `DELETE` removes `dav_nodes`/`dav_props`/`dav_locks` outright — RFC 4918
 * wants the resource gone and leaves no room for a tombstone. So there is no
 * change log to read, and a two-way sync provably cannot distinguish "the user
 * deleted this on the remote" from "this path was never there" or "the listing
 * that should have mentioned it came back truncated". All three look identical
 * to a stateless comparison.
 *
 * This table is that missing record: for each path, what *both* sides looked
 * like the last time they agreed. Every later decision is a comparison against
 * it, which is what makes delete propagation possible at all.
 *
 * ## Why it lives here and not in D1
 *
 * It is per-file state for a bucket that can hold a five-gigabyte tree, and D1
 * meters rows *read* against a daily budget. It also has to be read and written
 * together with the tree it describes, and only the Durable Object can enumerate
 * that tree. Putting it in the DO keeps one storage authority per question:
 * D1 answers "which replications are due", this answers "what changed".
 *
 * `dav_replica_state` is included in `CASCADE_TABLES`/`RENAME_CASCADE_TABLES` in
 * `meta.ts`, so a client `MOVE`/`DELETE` keeps this in step with `dav_nodes`.
 */

import { isMissingSchemaError } from '@durable-dav/shared/utils';

import type { DurableSqlStorage } from './meta';

type SqlRow = Record<string, unknown>;

/**
 * What the two trees looked like when they last agreed, for one path.
 *
 * `local_*` and `remote_*` are independent on purpose. They are captured from
 * two different servers at two different moments, and assuming they describe one
 * instant is how a sync ends up re-transferring an unchanged file on every pass
 * forever.
 */
type ReplicaStateRow = {
  replicationId: string;
  path: string;
  isCollection: boolean;
  localEtag: string | null;
  localMtime: number | null;
  localSize: number | null;
  remoteEtag: string | null;
  remoteMtime: number | null;
  remoteSize: number | null;
  contentType: string | null;
  syncedAt: number;
};

/**
 * Create the table. Idempotent, and safe to call on a volume provisioned before
 * replication existed — which is every volume deployed today.
 *
 * Separate from `ensureDavSchema` rather than folded in, so a volume with no
 * replication pays nothing for the table and the dependency runs one way:
 * `replication.ts` imports from `meta.ts`, never the reverse.
 */
function ensureReplicationSchema(sql: DurableSqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS dav_replica_state (
      replication_id TEXT NOT NULL,
      path           TEXT NOT NULL,
      is_collection  INTEGER NOT NULL DEFAULT 0,
      local_etag     TEXT,
      local_mtime    INTEGER,
      local_size     INTEGER,
      remote_etag    TEXT,
      remote_mtime   INTEGER,
      remote_size    INTEGER,
      content_type   TEXT,
      synced_at      INTEGER NOT NULL,
      PRIMARY KEY (replication_id, path)
    );
  `);
  // The sweep reads every row for one replication, ordered by path so a
  // resumed pass can start where it stopped.
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_dav_replica_state_sync ON dav_replica_state(replication_id, path);`);
}

function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : null;
}

/**
 * Read a column that the schema declares `TEXT NOT NULL`.
 *
 * `String(value ?? '')` is the trap this avoids: a value that is not a string
 * renders as `[object Object]`, which then becomes a path and a
 * `replication_id` — i.e. a row that matches nothing, silently.
 */
function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  // Anything else is a shape this module never wrote, and stringifying it would
  // produce `[object Object]` — a "path" that matches nothing, silently.
  return '';
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function toReplicaState(row: SqlRow): ReplicaStateRow {
  return {
    replicationId: text(row, 'replication_id'),
    path: text(row, 'path'),
    isCollection: Number(row.is_collection ?? 0) === 1,
    localEtag: nullableString(row, 'local_etag'),
    localMtime: nullableNumber(row, 'local_mtime'),
    localSize: nullableNumber(row, 'local_size'),
    remoteEtag: nullableString(row, 'remote_etag'),
    remoteMtime: nullableNumber(row, 'remote_mtime'),
    remoteSize: nullableNumber(row, 'remote_size'),
    contentType: nullableString(row, 'content_type'),
    syncedAt: nullableNumber(row, 'synced_at') ?? 0,
  };
}


/**
 * The recorded base for one replication, keyed by path.
 *
 * Degrades to an empty map **only** on a missing table — a volume provisioned
 * before 0006. Every other SQL error propagates: an unreadable base must not
 * read as "nothing has ever been synced", because that turns every file on both
 * sides into a fresh conflict and, worse, makes every recorded deletion look
 * like a path that never existed.
 */
function loadReplicaState(sql: DurableSqlStorage, replicationId: string): Map<string, ReplicaStateRow> {
  let rows: SqlRow[];
  try {
    rows = sql
      .exec(
        'SELECT * FROM dav_replica_state WHERE replication_id = ? ORDER BY path ASC',
        replicationId,
      )
      .toArray();
  } catch (error) {
    if (isMissingSchemaError(error)) return new Map();
    throw error;
  }
  const out = new Map<string, ReplicaStateRow>();
  for (const row of rows) {
    const state = toReplicaState(row);
    if (state.path !== '') out.set(state.path, state);
  }
  return out;
}

type ReplicaStateWrite = Omit<ReplicaStateRow, 'syncedAt'> & { syncedAt?: number };

/**
 * Record the agreement for a batch of paths.
 *
 * One statement per row rather than a loop of transactions: DO storage is
 * already implicitly transactional per invocation, and a pass can touch
 * thousands of paths.
 */
function saveReplicaState(sql: DurableSqlStorage, replicationId: string, writes: readonly ReplicaStateWrite[], now: number): void {
  for (const write of writes) {
    sql.exec(
      `INSERT INTO dav_replica_state (replication_id, path, is_collection, local_etag, local_mtime, local_size, remote_etag, remote_mtime, remote_size, content_type, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(replication_id, path) DO UPDATE SET
         is_collection = excluded.is_collection,
         local_etag = excluded.local_etag,
         local_mtime = excluded.local_mtime,
         local_size = excluded.local_size,
         remote_etag = excluded.remote_etag,
         remote_mtime = excluded.remote_mtime,
         remote_size = excluded.remote_size,
         content_type = excluded.content_type,
         synced_at = excluded.synced_at`,
      replicationId,
      write.path,
      write.isCollection ? 1 : 0,
      write.localEtag,
      write.localMtime,
      write.localSize,
      write.remoteEtag,
      write.remoteMtime,
      write.remoteSize,
      write.contentType,
      write.syncedAt ?? now,
    );
  }
}

/**
 * Forget a path on both sides — the "gone from both trees" case.
 *
 * Distinct from leaving the row in place: a stale row for a path that no longer
 * exists anywhere would keep re-proposing the same deletion on every future
 * pass, and would pin the path in every conflict listing.
 */
function forgetReplicaPaths(sql: DurableSqlStorage, replicationId: string, paths: readonly string[]): void {
  for (const path of paths) {
    sql.exec('DELETE FROM dav_replica_state WHERE replication_id = ? AND path = ?', replicationId, path);
  }
}

/**
 * Drop every recorded path for one replication.
 *
 * Called when the replication itself is deleted. Without it a re-created
 * replication with the same target inherits the old base and its first pass
 * computes deltas against a tree that no longer exists — reporting thousands of
 * unchanged files and propagating deletions the owner never asked for.
 */
function forgetReplication(sql: DurableSqlStorage, replicationId: string): void {
  sql.exec('DELETE FROM dav_replica_state WHERE replication_id = ?', replicationId);
}

/**
 * Recorded deletions for one replication, as inner paths.
 *
 * Read by the sweep's staleness guard: a pass that died mid-flight leaves rows
 * behind, and those rows are the only evidence that the pass was incomplete.
 */
function replicaPaths(sql: DurableSqlStorage, replicationId: string): string[] {
  try {
    const rows = sql.exec('SELECT path FROM dav_replica_state WHERE replication_id = ? ORDER BY path ASC', replicationId).toArray();
    return rows.map((row) => text(row, 'path')).filter((path) => path !== '');

  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
}

export {
  ensureReplicationSchema,
  loadReplicaState,
  saveReplicaState,
  forgetReplicaPaths,
  forgetReplication,
  replicaPaths,
  
};
export type { ReplicaStateRow, ReplicaStateWrite,  };
export {subtreePredicate, type DurableSqlStorage} from './meta';
