import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, migrationFileNames } from '../helpers/migrations';

/**
 * Migration 0007 (`pull-only` + `mirror_deletions`) upgrade safety.
 *
 * Widening the `mode` CHECK means rebuilding `dav_replications`, and that table is
 * the *parent* of `dav_replication_conflicts` via `ON DELETE CASCADE`. D1 honours
 * neither `PRAGMA foreign_keys = off` nor `legacy_alter_table` (0004), so a rebuild
 * that drops the parent with the audit rows still attached destroys the audit
 * trail — silently, and with no error to notice.
 *
 * So the thing worth proving here is not the new column. It is that the ordering in
 * 0007 is the ordering that survives: every seeded replication *and* every seeded
 * conflict row comes out the other side, no foreign key dangles, and a row written
 * before the migration is a safe copy rather than a mirror.
 */

const DB = env.DB as D1Database;
const PULL_ONLY = '0007_replication_pull_only.sql';
const REPLICATION = '0006_replication.sql';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function countRows(table: string): Promise<number> {
  const row = await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function foreignKeyViolations(): Promise<unknown[]> {
  const result = await DB.prepare('PRAGMA foreign_key_check').all<Record<string, unknown>>();
  return result.results ?? [];
}

/**
 * Seed the 0006 shape: the wide range of `mode` values, both `kind`s of conflict,
 * and a row with a resolved conflict so the nullable column is exercised too.
 */
async function seedPrePullOnly(): Promise<void> {
  const now = nowSeconds();
  await DB.prepare('INSERT INTO users (email, created_at, username, updated_at) VALUES (?, ?, ?, ?)').bind('alice@example.com', now, 'alice', now).run();
  await DB.prepare(
    'INSERT INTO dav_volumes (id, owner_email, owner, name, is_private, created_at, updated_at, owner_ci, name_ci) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
  )
    .bind('vol_1', 'alice@example.com', 'alice', 'demo', now, now, 'alice', 'demo')
    .run();

  const replications: Array<[string, string]> = [
    ['rep_copy', 'copy-only'],
    ['rep_sync', 'sync'],
    ['rep_keep', 'keep-both'],
  ];
  for (const [replicationId, mode] of replications) {
    await DB.prepare(
      `INSERT INTO dav_replications (replication_id, volume_id, target_kind, remote_url, remote_owner, remote_volume, remote_path,
        auth_kind, mode, interval_minutes, enabled, created_at, updated_at, created_by)
       VALUES (?, 'vol_1', 'dav', ?, '', '', '', 'none', ?, 60, 1, ?, ?, 'alice@example.com')`,
    )
      .bind(replicationId, `https://example.com/${replicationId}`, mode, now, now)
      .run();
  }

  const conflicts: Array<[string, string, string, number | null]> = [
    ['cfl_1', 'rep_keep', 'conflict', null],
    ['cfl_2', 'rep_keep', 'deletion', 1_700_000_000],
  ];
  for (const [conflictId, replicationId, kind, resolvedAt] of conflicts) {
    await DB.prepare(
      `INSERT INTO dav_replication_conflicts (conflict_id, replication_id, path, winner, kept_path, kind, detected_at, resolved_at)
       VALUES (?, ?, 'a/b.txt', 'remote', 'a/b.conflict-1.txt', ?, ?, ?)`,
    )
      .bind(conflictId, replicationId, kind, now, resolvedAt)
      .run();
  }
}

describe('migration 0007 — pull-only replication', () => {
  beforeEach(async () => {
    // D1 state persists across the tests in a file, so every test starts from empty
    // rather than assuming a fresh database. Applying the full chain without this
    // fails on the second test at 0004's `ALTER TABLE users ADD COLUMN id`.
    await DB.batch(DROP_EVERYTHING.map((sql) => DB.prepare(sql)));
  });

  it('is applied last', () => {
    expect(migrationFileNames().at(-1)).toBe(PULL_ONLY);
  });

  describe('upgrade', () => {
    beforeEach(async () => {
      await applyMigrations(DB, { to: REPLICATION });
      await seedPrePullOnly();
      await applyMigrations(DB, { from: PULL_ONLY });
    });

    it('keeps every replication and every conflict row', async () => {
      // The whole reason the rebuild is ordered the way it is. A parent drop with
      // the audit rows attached cascades them away with no error.
      expect(await countRows('dav_replications')).toBe(3);
      expect(await countRows('dav_replication_conflicts')).toBe(2);
    });

    it('leaves no foreign key dangling', async () => {
      // The rebuilt child table's FK is renamed twice — pointed at `_new`, then
      // rewritten by the parent rename. A missed rewrite fails here rather than on
      // the first delete of a replication.
      expect(await foreignKeyViolations()).toEqual([]);
    });

    it('copies each mode verbatim and defaults a pre-0007 row to a safe copy', async () => {
      const rows = await DB.prepare('SELECT replication_id, mode, mirror_deletions, enabled, last_status, created_by FROM dav_replications ORDER BY replication_id').all<{
        replication_id: string;
        mode: string;
        mirror_deletions: number;
        enabled: number;
        last_status: string | null;
        created_by: string | null;
      }>();
      expect(rows.results?.map((row) => [row.replication_id, row.mode, row.mirror_deletions])).toEqual([
        ['rep_copy', 'copy-only', 0],
        ['rep_keep', 'keep-both', 0],
        ['rep_sync', 'sync', 0],
      ]);
      // The rest of the row is carried across, not defaulted away.
      expect(rows.results?.every((row) => row.enabled === 1 && row.created_by === 'alice@example.com')).toBe(true);
    });

    it('preserves conflict rows with both kinds and a resolved one', async () => {
      const rows = await DB.prepare('SELECT conflict_id, kind, kept_path, resolved_at FROM dav_replication_conflicts ORDER BY conflict_id').all<{
        conflict_id: string;
        kind: string;
        kept_path: string | null;
        resolved_at: number | null;
      }>();
      expect(rows.results).toEqual([
        { conflict_id: 'cfl_1', kind: 'conflict', kept_path: 'a/b.conflict-1.txt', resolved_at: null },
        { conflict_id: 'cfl_2', kind: 'deletion', kept_path: 'a/b.conflict-1.txt', resolved_at: 1_700_000_000 },
      ]);
    });

    it('still cascades a deleted replication to its conflicts', async () => {
      // The rebuilt FK must be a *working* cascade, not merely one that passes
      // `foreign_key_check`. Without it the audit rows would outlive the target.
      await DB.prepare('DELETE FROM dav_replications WHERE replication_id = ?').bind('rep_keep').run();
      expect(await countRows('dav_replication_conflicts')).toBe(0);
      expect(await countRows('dav_replications')).toBe(2);
    });

    it('still cascades a deleted volume to its replications', async () => {
      await DB.prepare('DELETE FROM dav_volumes WHERE id = ?').bind('vol_1').run();
      expect(await countRows('dav_replications')).toBe(0);
    });
  });

  describe('constraints', () => {
    beforeEach(async () => {
      await applyMigrations(DB);
      const now = nowSeconds();
      await DB.prepare('INSERT INTO users (email, created_at, username, updated_at) VALUES (?, ?, ?, ?)').bind('a@example.com', now, 'a', now).run();
      await DB.prepare(
        'INSERT INTO dav_volumes (id, owner_email, owner, name, is_private, created_at, updated_at, owner_ci, name_ci) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
      )
        .bind('vol_p', 'a@example.com', 'a', 'demo', now, now, 'a', 'demo')
        .run();
    });

    it('accepts pull-only and refuses an unknown mode', async () => {
      const now = nowSeconds();
      const insert = (replicationId: string, mode: string): Promise<unknown> =>
        DB.prepare(
          `INSERT INTO dav_replications (replication_id, volume_id, target_kind, auth_kind, mode, interval_minutes, created_at, updated_at)
           VALUES (?, 'vol_p', 'dav', 'none', ?, 60, ?, ?)`,
        )
          .bind(replicationId, mode, now, now)
          .run();

      await expect(insert('rep_pull', 'pull-only')).resolves.toBeDefined();
      // The CHECK is the backstop behind `oneOf`, which answers 400 first. A value
      // the service would have rejected must still not reach storage.
      await expect(insert('rep_bad', 'pull-everything')).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('refuses a non-boolean mirror_deletions', async () => {
      await expect(
        DB.prepare(
          `INSERT INTO dav_replications (replication_id, volume_id, target_kind, auth_kind, mode, mirror_deletions, interval_minutes, created_at, updated_at)
           VALUES ('rep_m', 'vol_p', 'dav', 'none', 'pull-only', 2, 60, 1, 1)`,
        ).run(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    });
  });
});

/**
 * Every table the migration suite builds, so each test starts from empty.
 *
 * Ordered child-first for the same reason 0007 is: a `DELETE` that removes a parent
 * before its child cascades, and the *next* `CREATE TABLE` in the batch would then
 * fail against a parent whose rows are already gone.
 */
const DROP_EVERYTHING = [
  'DROP TABLE IF EXISTS dav_replication_conflicts',
  'DROP TABLE IF EXISTS dav_replications',
  'DROP TABLE IF EXISTS dav_replica_state',
  'DROP TABLE IF EXISTS dav_locks',
  'DROP TABLE IF EXISTS dav_props',
  'DROP TABLE IF EXISTS dav_nodes',
  'DROP TABLE IF EXISTS dav_credentials',
  'DROP TABLE IF EXISTS dav_volumes',
  'DROP TABLE IF EXISTS namespaces',
  'DROP TABLE IF EXISTS user_emails',
  'DROP TABLE IF EXISTS users',
];