-- Migration 0007: `pull-only` replication, and per-replication mirror deletions.
--
-- ## What changes
--
--   mode            gains 'pull-only' — the remote is the sole writer.
--   mirror_deletions a per-target boolean. Only meaningful for 'pull-only', where
--                    it chooses whether a local path the remote does not have is
--                    removed locally (true, exact mirror) or left alone (false,
--                    the safe copy). Defaults to 0, so the destructive reading is
--                    opt-in and a row written before this migration is a safe copy.
--
-- ## Why this is a table rebuild, and why it is *two* tables
--
-- SQLite cannot ALTER a CHECK constraint, so widening `mode` means rebuilding
-- `dav_replications`. That is the 0002 shape, except 0002's rebuild had no child
-- table and this one does: `dav_replication_conflicts.replication_id` is
-- `ON DELETE CASCADE`, and D1 honours neither `PRAGMA foreign_keys = off` nor
-- `legacy_alter_table` (0004). A `DROP TABLE dav_replications` with the audit rows
-- still attached therefore cascades them away, and the audit trail is the one thing
-- that makes a destructive decision explainable afterwards. So both tables are
-- rebuilt, and the order is load-bearing:
--
--   1. Build `dav_replication_conflicts_new` with its FK aimed at
--      `dav_replications_new`, so the new child never references the table that is
--      about to be dropped.
--   2. Copy the parent, THEN the child. The child's FK points at the new parent, so
--      copying the child first would violate it on every row — and the copy is a
--      plain `INSERT` precisely so that comes back as an error rather than as
--      `INSERT OR IGNORE` quietly discarding the audit trail.
--   3. Drop the old child FIRST. It has no children of its own, so this cascades
--      nothing.
--   4. Drop the old parent. Nothing references it any more.
--   5. Rename the new parent, then the new child. SQLite rewrites the child's FK
--      clause on the parent's rename, which is why the child is renamed after: a
--      rename is a moment at which the schema is reparsed, and the old name must be
--      gone by then.
--
-- Dropping the child first is the whole trick. In the other order the parent drop
-- fires `ON DELETE CASCADE` against live rows and the audit trail is lost with no
-- error — which is precisely the failure 0004 was written up to prevent.
--
-- Additive in effect: every existing row is copied verbatim, `mirror_deletions`
-- takes the safe default, and no existing `mode` value changes meaning.

CREATE TABLE IF NOT EXISTS dav_replication_conflicts_new (
  conflict_id     TEXT PRIMARY KEY,
  replication_id  TEXT NOT NULL,
  path            TEXT NOT NULL,
  -- 'local' when the Durable-DAV version won, 'remote' when the remote's did.
  winner          TEXT NOT NULL CHECK(winner IN ('local', 'remote')),
  -- For 'keep-both' and 'pull-only', the sibling copy actually written, always on
  -- the local side. Null for 'sync', where the loser is discarded.
  kept_path       TEXT,
  -- 'conflict'   → both sides changed; resolved by mode.
  -- 'deletion'   → one side deleted a path the other still had, and the gate
  --                allowed it through. Recorded so every propagated delete is
  --                attributable after the fact.
  kind            TEXT NOT NULL DEFAULT 'conflict' CHECK(kind IN ('conflict', 'deletion')),
  detected_at     INTEGER NOT NULL,
  resolved_at     INTEGER,
  FOREIGN KEY (replication_id) REFERENCES dav_replications_new(replication_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dav_replications_new (
  replication_id       TEXT PRIMARY KEY,
  volume_id            TEXT NOT NULL,
  -- 'dav'        → an external WebDAV server, reached over HTTPS.
  -- 'dav-volume' → a sibling bucket on this deployment, reached by DO RPC. No
  --                egress, so it is not subject to the SSRF policy at all.
  target_kind          TEXT NOT NULL CHECK(target_kind IN ('dav', 'dav-volume')),
  -- All four are NOT NULL DEFAULT '' rather than nullable so the natural key
  -- below can be a plain SQLite UNIQUE index. Expression indexes would work,
  -- but a null in a UNIQUE column means "not comparable to anything" and would
  -- let the same target be registered twice under two spellings of "absent".
  remote_url           TEXT NOT NULL DEFAULT '',
  remote_owner         TEXT NOT NULL DEFAULT '',
  remote_volume        TEXT NOT NULL DEFAULT '',
  remote_path          TEXT NOT NULL DEFAULT '',
  auth_kind            TEXT NOT NULL DEFAULT 'none' CHECK(auth_kind IN ('none', 'basic', 'bearer')),
  -- AES-GCM envelope; decryptable only with REPLICATION_ENCRYPTION_KEY. Null
  -- whenever auth_kind = 'none'. Never leaves the server, and no API route
  -- returns it.
  encrypted_secret     TEXT,
  secret_iv            TEXT,
  -- 'copy-only'  → Durable-DAV is the sole writer. The remote is a mirror.
  -- 'sync'       → both directions; a genuine conflict resolves by mtime.
  -- 'keep-both'  → both directions; a conflict never overwrites, it writes a
  --                 sibling copy and records the row.
  -- 'pull-only'  → the *remote* is the sole writer. Nothing is ever pushed. The
  --                 remote's version always wins, and a local version that would
  --                 have been overwritten is preserved beside it instead.
  mode                 TEXT NOT NULL DEFAULT 'keep-both' CHECK(mode IN ('copy-only', 'sync', 'keep-both', 'pull-only')),
  -- Remove local paths the remote does not have. Read only by 'pull-only'; the
  -- service refuses `1` on any other mode rather than storing a flag that means
  -- nothing there. Deletions it authorizes still pass through the ordinary
  -- absence gate (`trustAbsences` plus `pass_started_at`), so an incomplete
  -- listing cannot activate it.
  mirror_deletions     INTEGER NOT NULL DEFAULT 0 CHECK(mirror_deletions IN (0, 1)),
  interval_minutes     INTEGER NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  last_run_at          INTEGER,
  -- 'ok' | 'partial' | 'failed'. 'partial' is not cosmetic: deletions are only
  -- propagated on an 'ok' pass, so a half-finished pass must be distinguishable
  -- from a clean one at the point the decision is made.
  last_status          TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Resumable sweep state. A full two-way sync does not fit in one cron tick's
  -- CPU budget, so a tick that runs out of budget parks its position here and
  -- the next tick continues. `pass_started_at` is the deletion gate: non-null
  -- means a pass is in flight, and a pass that ends with any error clears it
  -- without propagating a single deletion.
  cursor_path          TEXT,
  cursor_remaining     INTEGER NOT NULL DEFAULT 0,
  pass_started_at      INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  -- The creator's frozen `users.email` anchor. Attribution only — ownership
  -- rides on `volume_id`, exactly as it does for credentials.
  created_by           TEXT,
  FOREIGN KEY (volume_id) REFERENCES dav_volumes(id) ON DELETE CASCADE,
  -- One target per (volume, target) pair. The runner relies on this to make
  -- "reconfigure the same target" an upsert rather than a second row racing the
  -- first on every tick.
  UNIQUE (volume_id, target_kind, remote_url, remote_owner, remote_volume, remote_path)
);

-- The parent is copied FIRST, while the child's new table is still empty.
--
-- This ordering is load-bearing and the failure it avoids is silent. The child's FK
-- names `dav_replications_new`, and FK enforcement is on, so copying the child
-- before the parent raises a constraint violation on every row — and
-- `INSERT OR IGNORE` answers a foreign-key violation by *ignoring the row*. The
-- migration would then succeed having dropped the entire audit trail, which is the
-- one thing this file exists to protect. Plain `INSERT`, parent first.
INSERT INTO dav_replications_new
  (replication_id, volume_id, target_kind, remote_url, remote_owner, remote_volume, remote_path,
   auth_kind, encrypted_secret, secret_iv, mode, mirror_deletions, interval_minutes, enabled,
   last_run_at, last_status, last_error, consecutive_failures, cursor_path, cursor_remaining,
   pass_started_at, created_at, updated_at, created_by)
  SELECT replication_id, volume_id, target_kind, remote_url, remote_owner, remote_volume, remote_path,
   auth_kind, encrypted_secret, secret_iv, mode, 0, interval_minutes, enabled,
   last_run_at, last_status, last_error, consecutive_failures, cursor_path, cursor_remaining,
   pass_started_at, created_at, updated_at, created_by
  FROM dav_replications;

-- Every column is copied by name rather than `SELECT *`, so a column added to either
-- table after this file was written fails loudly here instead of silently shifting
-- into the wrong target.
INSERT INTO dav_replication_conflicts_new
  (conflict_id, replication_id, path, winner, kept_path, kind, detected_at, resolved_at)
  SELECT conflict_id, replication_id, path, winner, kept_path, kind, detected_at, resolved_at
  FROM dav_replication_conflicts;

-- Child first, then parent. See the header: the other order cascades the audit
-- rows away, and D1 will not let us turn the cascade off.
DROP TABLE IF EXISTS dav_replication_conflicts;
DROP TABLE IF EXISTS dav_replications;

ALTER TABLE dav_replications_new RENAME TO dav_replications;
ALTER TABLE dav_replication_conflicts_new RENAME TO dav_replication_conflicts;

-- The cron's only hot query. `enabled = 1 AND (last_run_at IS NULL OR
-- last_run_at + interval_minutes * 60 <= ?)` needs both columns in the index or
-- it degrades to a scan of every replication on the deployment.
CREATE INDEX IF NOT EXISTS idx_dav_replications_due ON dav_replications(enabled, last_run_at);
CREATE INDEX IF NOT EXISTS idx_dav_replications_volume ON dav_replications(volume_id);
CREATE INDEX IF NOT EXISTS idx_dav_replication_conflicts_replication ON dav_replication_conflicts(replication_id, detected_at);