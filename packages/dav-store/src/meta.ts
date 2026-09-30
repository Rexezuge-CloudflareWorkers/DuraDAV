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
      crtime INTEGER NOT NULL
    );
  `);
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

function upsertNode(
  sql: DurableSqlStorage,
  path: string,
  fields: { isCollection: boolean; contentType?: string; etag?: string; mtime?: number; crtime?: number },
): void {
  const mtime = fields.mtime ?? nowMs();
  const crtime = fields.crtime ?? mtime;
  sql.exec(
    `INSERT INTO dav_nodes (path, is_collection, content_type, etag, mtime, crtime)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET is_collection=excluded.is_collection, content_type=excluded.content_type, etag=excluded.etag, mtime=excluded.mtime`,
    path,
    fields.isCollection ? 1 : 0,
    fields.contentType ?? null,
    fields.etag ?? null,
    mtime,
    crtime,
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

const CASCADE_TABLES = ['dav_nodes', 'dav_props', 'dav_locks'] as const;

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
  for (const table of CASCADE_TABLES) {
    // The leading `from` segment is replaced by the `to` binding; `SUBSTR`
    // re-anchors the untouched suffix. Only the table name is interpolated and
    // it comes from the closed `CASCADE_TABLES` set, never from input.
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

export { ensureDavSchema, upsertNode, deleteNodeCascade, renameNodeCascade, getDeadProperties };
export type { DurableSqlStorage };
