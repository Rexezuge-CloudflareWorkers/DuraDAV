import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export interface DavReplicationConflictRow {
  conflict_id: string;
  replication_id: string;
  path: string;
  winner: string;
  kept_path: string | null;
  kind: string;
  detected_at: number;
  resolved_at: number | null;
}

/**
 * The audit trail for every destructive or ambiguous decision a sync made.
 *
 * Two kinds, and the second is why this table exists at all: a two-way sync
 * that deletes on *both* sides is the most dangerous thing this codebase does,
 * and once a deletion has propagated there is no undo. Recording every one
 * turns "the file is gone" from an archaeology problem into a lookup.
 */
class DavReplicationConflictDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async record(input: {
    conflictId: string;
    replicationId: string;
    path: string;
    winner: 'local' | 'remote';
    keptPath: string | null;
    kind: 'conflict' | 'deletion';
    now: number;
  }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO dav_replication_conflicts (conflict_id, replication_id, path, winner, kept_path, kind, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(input.conflictId, input.replicationId, input.path, input.winner, input.keptPath, input.kind, input.now)
          .run(),
      'record dav replication conflict',
    );
  }

  public async listByReplication(replicationId: string, includeResolved: boolean, limit = 200): Promise<DavReplicationConflictRow[]> {
    const result = await this.database
      .prepare(
        `SELECT * FROM dav_replication_conflicts
         WHERE replication_id = ? ${includeResolved ? '' : 'AND resolved_at IS NULL'}
         ORDER BY detected_at DESC LIMIT ?`,
      )
      .bind(replicationId, limit)
      .all<DavReplicationConflictRow>();
    return result.results ?? [];
  }

  public async countUnresolved(replicationId: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS cnt FROM dav_replication_conflicts WHERE replication_id = ? AND resolved_at IS NULL')
      .bind(replicationId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  /**
   * Mark resolved.
   *
   * Guarded on `resolved_at IS NULL` so resolving twice is idempotent rather
   * than the second call silently rewriting when it was first handled — the
   * caller has already pushed a side by then, and doing that twice would write
   * the same bytes over a file a user may have edited since.
   */
  public async markResolved(replicationId: string, conflictId: string, now: number): Promise<boolean> {
    const result = await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE dav_replication_conflicts SET resolved_at = ? WHERE conflict_id = ? AND replication_id = ? AND resolved_at IS NULL')
          .bind(now, conflictId, replicationId)
          .run(),
      'resolve dav replication conflict',
    );
    return (result.meta?.changes ?? 0) > 0;
  }

  public async deleteForReplication(replicationId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM dav_replication_conflicts WHERE replication_id = ?').bind(replicationId).run(),
      'delete dav replication conflicts',
    );
  }
}

export { DavReplicationConflictDAO };
