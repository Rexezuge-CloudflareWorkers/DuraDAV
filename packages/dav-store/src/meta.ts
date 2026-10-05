import type { DeadProperty } from '@durable-dav/webdav';
import { isMissingSchemaError } from '@durable-dav/shared/utils';

type SqlRow = Record<string, unknown>;

type DurableSqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => { toArray: () => SqlRow[]; one?: () => SqlRow | undefined };
};

function ensureDavSchema(sql: DurableSqlStorage): void {
  // `content_language` and `displayname` were declared here and never written
  // or read: `displayname` is derived from the path in `DavRepository`, and
  // `contentLanguage` was a permanently-`undefined` field, which made
  // `getcontentlanguage` absent from every PROPFIND while the schema claimed to
  // store it. Both are dropped. A `CREATE TABLE IF NOT EXISTS` does not
  // migrate an existing DO, so an already-provisioned volume keeps the two
  // nullable columns until it is deleted — harmless, since nothing selects them.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS dav_nodes (
      path TEXT PRIMARY KEY,
      is_collection INTEGER NOT NULL DEFAULT 0,
      content_type TEXT,
      etag TEXT,
      mtime INTEGER NOT NULL,
      crtime INTEGER NOT NULL,
      lock_null INTEGER NOT NULL DEFAULT 0
    );
  `);
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a volume provisioned before
  // `lock_null` existed, so the column has to be added separately. Guarded on
  // the "duplicate column" error, which is how SQLite reports the second run —
  // not on the absence of an error, so a genuinely broken statement still
  // surfaces. This is a DO-local schema step, not a D1 migration: `dav_nodes`
  // never exists in D1.
  try {
    sql.exec(`ALTER TABLE dav_nodes ADD COLUMN lock_null INTEGER NOT NULL DEFAULT 0;`);
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS dav_props (
      path TEXT NOT NULL,
      namespace_uri TEXT NOT NULL,
      local_name TEXT NOT NULL,
      prefix TEXT,
      value_xml TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (path, namespace_uri, local_name)
    );
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_dav_props_path ON dav_props(path);`);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS dav_locks (
      token TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'exclusive',
      depth TEXT NOT NULL DEFAULT '0',
      owner TEXT,
      timeout TEXT NOT NULL DEFAULT '',
      expires_at INTEGER NOT NULL,
      root TEXT NOT NULL DEFAULT '/'
    );
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_dav_locks_path ON dav_locks(path);`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_dav_locks_expires ON dav_locks(expires_at);`);
}

function nowMs(): number {
  return Date.now();
}

/**
 * Write one dead property, replacing any existing value for that name.
 *
 * The `dav_props` upsert existed in four places — `PropMethods`, `DavRepository`,
 * `VolumeTransfer`, and `replicaOperations` — as the same statement with the
 * same `?? ''`/`?? null` normalizations. `meta.ts` already owns every other
 * `dav_props` statement (`getDeadProperties` above, the cascades below), so this
 * is where it belongs; four copies is four chances to disagree about what a
 * missing namespace or prefix means, and a disagreement here is a dead property
 * that PROPFIND cannot find afterwards.
 *
 * `namespaceURI` and `localName` default to `''` rather than being rejected,
 * matching what the four callers each did on their own.
 */
function upsertDeadProperty(sql: DurableSqlStorage, path: string, property: DeadProperty): void {
  sql.exec(
    `INSERT INTO dav_props (path, namespace_uri, local_name, prefix, value_xml) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, namespace_uri, local_name) DO UPDATE SET prefix=excluded.prefix, value_xml=excluded.value_xml`,
    path,
    property.namespaceURI ?? '',
    property.localName ?? '',
    property.prefix ?? null,
    property.valueXml ?? '',
  );
}

/**
 * Did this statement fail only because the column is already there?
 *
 * The alternative — ignoring the error — would also swallow a genuinely broken
 * `ALTER`, leaving an old volume permanently without the column while the code
 * reads it. Only this narrow outcome is forgiven, which mirrors the
 * fail-closed rule `isMissingSchemaError` exists to enforce.
 */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /duplicate\s+column\s+name/i.test(message);
}

function stringField(row: SqlRow, key: string, fallback = ''): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : fallback;
}

function nullableStringField(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : undefined;
}

/**
 * Insert or refresh a node's metadata row.
 *
 * `lockNull` is explicit and required because it is the one field whose value
 * the *caller* owns and cannot be inferred: it marks a resource that exists
 * only to hold a lock, which `handleUnlock` is then allowed to delete. Every
 * caller knows its own answer — `PUT`/`MKCOL` say `false`, a LOCK that created
 * the file says `true` — and it is written on conflict as well as on insert so
 * that putting real content over a lock-null resource clears the flag.
 */
function upsertNode(
  sql: DurableSqlStorage,
  path: string,
  fields: { isCollection: boolean; contentType?: string; etag?: string; mtime?: number; crtime?: number; lockNull?: boolean },
): void {
  const mtime = fields.mtime ?? nowMs();
  const crtime = fields.crtime ?? mtime;
  sql.exec(
    `INSERT INTO dav_nodes (path, is_collection, content_type, etag, mtime, crtime, lock_null)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET is_collection=excluded.is_collection, content_type=excluded.content_type, etag=excluded.etag, mtime=excluded.mtime, lock_null=excluded.lock_null`,
    path,
    fields.isCollection ? 1 : 0,
    fields.contentType ?? null,
    fields.etag ?? null,
    mtime,
    crtime,
    fields.lockNull ? 1 : 0,
  );
}

/**
 * SQL fragment + bindings selecting `path` itself plus every descendant.
 *
 * Why `SUBSTR` and not `LIKE '${path}/%'`: SQL `LIKE` treats `_` as "any one
 * character" unless an `ESCAPE` clause is supplied, and `_` is legal in bucket
 * and file names. Deleting `report_2024` therefore also matched
 * `reportX2024/...` — the filesystem subtree was removed but rows for *live*
 * files were deleted too, while rows for already-deleted files survived. A
 * prefix-length comparison has no metacharacters and stays index-friendly
 * (the existing `path` indexes still cover it).
 */
function subtreePredicate(path: string): { clause: string; bindings: unknown[] } {
  return { clause: '(path = ? OR SUBSTR(path, 1, ?) = ?)', bindings: [path, path.length + 1, `${path}/`] };
}

/**
 * Tables a DELETE cascades through.
 *
 * `dav_replica_state` is deliberately **absent**, and that is the opposite of the
 * rule that governs `RENAME_CASCADE_TABLES` below. A MOVE moves the bytes, so the
 * record of where the two trees agreed must move with them. A DELETE moves nothing:
 * it removes the resource, and the record of that removal is the *only* evidence
 * the sync engine has that the path ever existed and is now gone.
 *
 * Cascading the row away on DELETE destroys that evidence, and the next pass reads
 * the surviving remote copy as a brand-new file and pulls it back — resurrecting a
 * file the user deleted, on a replication that reports itself perfectly healthy.
 * The leftover rows are not orphans: a path absent from both sides is forgotten by
 * the sync, and a path absent from one side is exactly the deletion queue.
 *
 * `dav_locks` *is* cascaded; RFC 4918 §7.4 releases a deleted subtree's locks.
 */
const CASCADE_TABLES = ['dav_nodes', 'dav_props', 'dav_locks'] as const;

/**
 * Tables a MOVE re-paths.
 *
 * `dav_locks` is deliberately excluded. RFC 4918 §7.6: "A successful MOVE
 * request on a write locked resource MUST NOT move the write lock with the
 * resource." Re-pathing the row therefore did the one thing the RFC forbids —
 * it carried a lock out of the collection it was taken on and applied it to a
 * resource in a collection the locker never named. §7.4 adds that an indirectly
 * locked member moved into an *unlocked* collection is thereafter unlocked,
 * which is exactly what dropping the row produces.
 *
 * §7.6 also requires the converse — the moved resource joins the destination
 * lock's scope — and that falls out of the guard rather than this function:
 * `DavLockGuard` matches locks on the path *and its ancestors*, so a member
 * moved under a locked collection is already covered by that ancestor's row.
 *
 * `dav_replica_state` is included, and `CASCADE_TABLES` above explains why the two
 * lists disagree about it: a MOVE relocates the resource, so its base row relocates
 * with it, while a DELETE removes the resource and must *keep* the row, because
 * that row is what lets the sync propagate the deletion to the other side.
 *
 * DELETE still cascades locks, so removing a subtree releases them.
 */
const RENAME_CASCADE_TABLES = ['dav_nodes', 'dav_props', 'dav_replica_state'] as const;

function deleteNodeCascade(sql: DurableSqlStorage, path: string): void {
  if (path === '') {
    for (const table of CASCADE_TABLES) sql.exec(`DELETE FROM ${table}`);
    return;
  }
  const { clause, bindings } = subtreePredicate(path);
  for (const table of CASCADE_TABLES) sql.exec(`DELETE FROM ${table} WHERE ${clause}`, ...bindings);
}

function renameNodeCascade(sql: DurableSqlStorage, from: string, to: string): void {
  const { clause, bindings } = subtreePredicate(from);
  for (const table of RENAME_CASCADE_TABLES) {
    // The leading `from` segment is replaced by the `to` binding; `SUBSTR`
    // re-anchors the untouched suffix. Only the table name is interpolated and
    // it comes from the closed `RENAME_CASCADE_TABLES` set, never from input.
    sql.exec(`UPDATE ${table} SET path = ? || SUBSTR(path, ?) WHERE ${clause}`, to, from.length + 1, ...bindings);
  }
}

/**
 * Dead properties for a path.
 *
 * Only a *missing table* degrades to `[]` — that is the one failure a
 * pre-schema volume can produce, and answering "no dead properties" is exactly
 * right there. Every other SQL error propagates: swallowing them meant a
 * corrupt, busy, or truncated database was reported to the client as "this
 * resource has no dead properties", so a `PROPPATCH` that had already written
 * the row would 404 that property in the very next PROPFIND with nothing
 * logged. A silent data-loss report is worse than a 500.
 */
function getDeadProperties(sql: DurableSqlStorage, path: string): DeadProperty[] {
  let rows: SqlRow[];
  try {
    rows = sql.exec(`SELECT namespace_uri, local_name, prefix, value_xml FROM dav_props WHERE path = ?`, path).toArray();
  } catch (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  return rows.map((row) => ({
    namespaceURI: stringField(row, 'namespace_uri', ''),
    localName: stringField(row, 'local_name', ''),
    prefix: nullableStringField(row, 'prefix') ?? null,
    valueXml: stringField(row, 'value_xml', ''),
  }));
}

export { ensureDavSchema, upsertNode, upsertDeadProperty, deleteNodeCascade, renameNodeCascade, getDeadProperties, subtreePredicate };
export type { DurableSqlStorage };
