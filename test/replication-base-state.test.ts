import { describe, expect, it } from 'vitest';
import { ensureReplicationSchema, forgetReplicaPaths, forgetReplication, loadReplicaState, replicaPaths, saveReplicaState } from '../packages/dav-store/src/replication';
import type { DurableSqlStorage, ReplicaStateRow } from '../packages/dav-store/src/replication';

/**
 * The DO-local sync base, against a recording SQL stub.
 *
 * Split out because this is the only record that a deletion is decidable from, and
 * a row that silently fails to persist is indistinguishable from a file that was
 * never synced: the next pass sees the path as new and pulls the remote's copy back
 * over the deletion. So the write/read round trip is pinned here rather than only
 * being exercised through a runner.
 */

/**
One row of `dav_replica_state`, in the column names SQLite hands back.

Deliberately *not* `ReplicaStateRow`, the shape the module converts a row into: a stub
answering in the converted shape would hand back `localEtag` where the real driver
hands back `local_etag`, and every field would read as null — which is exactly the "the
base vanished" failure this suite exists to catch, hidden inside the stub that is
supposed to rule it out.
*/
type SqlRow = {
  replication_id: string;
  path: string;
  [column: string]: string | number | boolean | null;
};

/**
Plain code-unit order, so two runs order the same set identically.
*/
function compareByPath(a: SqlRow, b: SqlRow): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/**
The single-column read: only the path, which is all `replicaPaths` needs.
*/
const pickPath = (row: SqlRow): Record<string, unknown> => ({ path: row.path });

/**
The full read, copied so a caller cannot mutate the fake's own table.
*/
const copyRow = (row: SqlRow): Record<string, unknown> => ({ ...row });

/**
Rows for one replication, in the order the query asks for.

Both reads are the same query with a different column list, so both get their rows from
here — and `ORDER BY path ASC` has to be honoured, since the order is what makes two runs
over the same set comparable.

`unicorn/prefer-simple-sort-comparator` is disabled here because it assumes a numeric
sort and offers `(a, b) => a.path - b.path`, which is `NaN` for strings. `compareByPath`
is the same total order the planner uses on real paths.
*/
function rowsFor(table: Map<string, SqlRow>, replicationId: unknown): SqlRow[] {
  return [...table.values()]
    .filter((row) => row.replication_id === String(replicationId))
    // eslint-disable-next-line unicorn/prefer-simple-sort-comparator -- see above
    .sort(compareByPath);
}

/**
Records every statement, and answers the two `SELECT`s from a table.
*/
function recordingSql() {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const table = new Map<string, SqlRow>();

  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      statements.push({ sql: query, bindings });
      const normalized = query.replaceAll(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO dav_replica_state')) {
        const [replicationId, path, isCollection, localEtag, localMtime, localSize, remoteEtag, remoteMtime, remoteSize, contentType, syncedAt] =
          bindings;
        table.set(`${String(replicationId)} ${String(path)}`, {
          replication_id: String(replicationId),
          path: String(path),
          is_collection: Number(isCollection) === 1,
          local_etag: localEtag as string | null,
          local_mtime: localMtime as number | null,
          local_size: localSize as number | null,
          remote_etag: remoteEtag as string | null,
          remote_mtime: remoteMtime as number | null,
          remote_size: remoteSize as number | null,
          content_type: contentType as string | null,
          synced_at: Number(syncedAt),
        });
        return { toArray: () => [] };
      }
      if (normalized.startsWith('DELETE FROM dav_replica_state WHERE replication_id = ?') && bindings.length === 1) {
        for (const key of table.keys()) {
          if (key.startsWith(`${String(bindings[0])} `)) table.delete(key);
        }
        return { toArray: () => [] };
      }
      if (normalized.startsWith('DELETE FROM dav_replica_state')) {
        const [replicationId, path] = bindings;
        table.delete(`${String(replicationId)} ${String(path)}`);
        return { toArray: () => [] };
      }
      // Both reads are one query with a different column list, so they share `rowsFor`
      // and differ only in what each row carries back. Anything else — the schema DDL,
      // and the `INSERT … ON CONFLICT` upsert — answers with no rows.
      let rows: Record<string, unknown>[] = [];
      if (normalized.startsWith('SELECT path FROM dav_replica_state')) {
        rows = rowsFor(table, bindings[0]).map(pickPath);
      } else if (normalized.startsWith('SELECT * FROM dav_replica_state')) {
        rows = rowsFor(table, bindings[0]).map(copyRow);
      }
      return { toArray: () => rows };
    },
  };
  return { statements, sql: sql as unknown as DurableSqlStorage, table };
}

function row(path: string, replicationId = 'rep_1'): ReplicaStateRow {
  return {
    replicationId,
    path,
    isCollection: false,
    localEtag: `"${path}-v1"`,
    localMtime: 1000,
    localSize: 10,
    remoteEtag: `"${path}-v1"`,
    remoteMtime: 1000,
    remoteSize: 10,
    contentType: 'text/plain',
    syncedAt: 1,
  };
}

describe('replica base — schema', () => {
  it('is idempotent, so a volume provisioned before 0006 is safe to run against', () => {
    const { sql, statements } = recordingSql();
    ensureReplicationSchema(sql);
    ensureReplicationSchema(sql);
    expect(statements.filter((entry) => entry.sql.includes('CREATE TABLE IF NOT EXISTS dav_replica_state'))).toHaveLength(2);
  });

  it('keys on (replication_id, path) so several targets cannot collide', () => {
    // The key is what makes `ON CONFLICT ... DO UPDATE` an overwrite rather than a
    // constraint failure, and what keeps two replications of the same bucket — to
    // different targets — from overwriting each other's base.
    const { sql, statements } = recordingSql();
    ensureReplicationSchema(sql);
    const created = statements.map((entry) => entry.sql).join('\n');
    expect(created).toContain('PRIMARY KEY (replication_id, path)');
  });
});

describe('replica base — round trip', () => {
  it('persists every path it is given', () => {
    // The failure this guards: a batch where only the first row landed, so the
    // second path looked un-synced forever and the sync re-pulled it every pass.
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('dir'), row('dir/a.txt'), row('dir/b.txt')], 5);
    const loaded = loadReplicaState(sql, 'rep_1');
    expect([...loaded.keys()].sort()).toEqual(['dir', 'dir/a.txt', 'dir/b.txt']);
  });

  it('keeps each path separate, including a collection and a file inside it', () => {
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('dir'), row('dir/a.txt')], 5);
    expect(loadReplicaState(sql, 'rep_1').get('dir')?.isCollection).toBe(false);
    expect(loadReplicaState(sql, 'rep_1').get('dir/a.txt')?.isCollection).toBe(false);
  });

  it('scopes rows to one replication', () => {
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('a.txt')], 5);
    saveReplicaState(sql, 'rep_2', [row('a.txt', 'rep_2'), row('b.txt', 'rep_2')], 5);
    expect([...loadReplicaState(sql, 'rep_1').keys()]).toEqual(['a.txt']);
    expect([...loadReplicaState(sql, 'rep_2').keys()].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('overwrites on re-record rather than accumulating rows', () => {
    // Re-recording is the normal case: every pass rewrites the base for the paths it
    // saw. If that inserted instead, the table would grow without bound and
    // `loadReplicaState` would return duplicates for one path.
    const { sql, statements } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('a.txt')], 5);
    saveReplicaState(sql, 'rep_1', [{ ...row('a.txt'), localEtag: '"a-v2"' }], 9);
    const loaded = loadReplicaState(sql, 'rep_1');
    expect(loaded.size).toBe(1);
    expect(loaded.get('a.txt')?.localEtag).toBe('"a-v2"');
    expect(statements.filter((entry) => entry.sql.includes('INSERT INTO dav_replica_state'))).toHaveLength(2);
    expect(statements.some((entry) => entry.sql.includes('ON CONFLICT(replication_id, path) DO UPDATE'))).toBe(true);
  });

  it('drops a path that reached neither side', () => {
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('a.txt'), row('b.txt')], 5);
    forgetReplicaPaths(sql, 'rep_1', ['a.txt']);
    expect([...loadReplicaState(sql, 'rep_1').keys()]).toEqual(['b.txt']);
  });

  it('drops everything for a deleted replication', () => {
    // Without this, a re-created target inherits a base describing a tree that no
    // longer exists and its first pass propagates deletions nobody asked for.
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('a.txt'), row('b.txt')], 5);
    forgetReplication(sql, 'rep_1');
    expect(loadReplicaState(sql, 'rep_1').size).toBe(0);
  });

  it('degrades to empty only for a pre-0006 volume', () => {
    // Every other SQL error must propagate: an unreadable base read as "nothing has
    // ever synced" turns every file on both sides into a fresh conflict and, worse,
    // every recorded deletion into a path that never existed.
    const exploding = {
      exec: () => {
        throw new Error('database is locked');
      },
    } as unknown as DurableSqlStorage;
    expect(() => loadReplicaState(exploding, 'rep_1')).toThrow('database is locked');
  });
});
describe('replica base — reading a single column', () => {
  it('lists recorded paths in order', () => {
    // Used by the sweep's staleness guard: a pass that died mid-flight leaves rows
    // behind, and those rows are the only evidence the pass was incomplete.
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('b.txt'), row('a.txt'), row('c/d.txt')], 5);
    expect(replicaPaths(sql, 'rep_1')).toEqual(['a.txt', 'b.txt', 'c/d.txt']);
  });

  it('is scoped to one replication', () => {
    const { sql } = recordingSql();
    ensureReplicationSchema(sql);
    saveReplicaState(sql, 'rep_1', [row('a.txt')], 5);
    saveReplicaState(sql, 'rep_2', [row('z.txt', 'rep_2')], 5);
    expect(replicaPaths(sql, 'rep_1')).toEqual(['a.txt']);
  });

  it('degrades to empty only for a pre-0006 volume', () => {
    const missing = {
      exec: () => {
        throw new Error('no such table: dav_replica_state');
      },
    } as unknown as DurableSqlStorage;
    expect(replicaPaths(missing, 'rep_1')).toEqual([]);
  });

  it('propagates any other SQL error', () => {
    const exploding = {
      exec: () => {
        throw new Error('database is locked');
      },
    } as unknown as DurableSqlStorage;
    expect(() => replicaPaths(exploding, 'rep_1')).toThrow('database is locked');
  });
});

describe('replica base — reading odd column values', () => {
  it('reads a non-string, non-numeric column without inventing a value', () => {
    // `String({})` is `[object Object]`, which would become a path matching nothing —
    // a row that silently reads as absent rather than as corrupt.
    const { sql } = recordingSql();
    saveReplicaState(sql, 'rep_1', [row('a.txt')], 5);
    const odd = {
      exec: () => ({ toArray: () => [{ replication_id: { nested: true }, path: ['a'], is_collection: 0 }] }),
    } as unknown as DurableSqlStorage;
    const loaded = loadReplicaState(odd, 'rep_1');
    expect(loaded.size).toBe(0);
  });

  it('reads numeric and boolean columns back as their text', () => {
    const numeric = {
      exec: () => ({ toArray: () => [{ replication_id: 7, path: 12, is_collection: 1, local_size: 42, synced_at: 5 }] }),
    } as unknown as DurableSqlStorage;
    const loaded = loadReplicaState(numeric, '7');
    expect(loaded.get('12')).toMatchObject({ isCollection: true, localSize: 42, syncedAt: 5 });
  });
});
