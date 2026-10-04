-- Migration 0006: Scheduled volume replication.
--
-- A replication binds one bucket to one remote and moves changes both ways on a
-- cron tick. Everything else about the design is downstream of one fact: DELETE
-- removes `dav_nodes`/`dav_props`/`dav_locks` outright, so there is no change
-- log and a two-way sync cannot infer a deletion without a recorded base. The
-- per-path base lives in the *Durable Object's* SQLite (`dav_replica_state`,
-- created by `ensureReplicationSchema`) rather than here — a 100k-file bucket
-- would otherwise put 100k rows in D1 against a 5M rows-read/day free-tier
-- budget, and D1 cannot see the tree anyway. This table holds only the
-- configuration and the run bookkeeping, which is what the cron tick actually
-- queries.
--
-- Additive and new-table-only, per the 0004 lesson: D1 honours neither
-- `PRAGMA foreign_keys = off` nor `legacy_alter_table`, and `defer_foreign_keys`
-- does not suppress `ON DELETE CASCADE`. Nothing here rebuilds an existing
-- table, so no row can be lost to a migration.

CREATE TABLE IF NOT EXISTS dav_replications (
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
  mode                 TEXT NOT NULL DEFAULT 'keep-both' CHECK(mode IN ('copy-only', 'sync', 'keep-both')),
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

-- The cron's only hot query. `enabled = 1 AND (last_run_at IS NULL OR
-- last_run_at + interval_minutes * 60 <= ?)` needs both columns in the index or
-- it degrades to a scan of every replication on the deployment.
CREATE INDEX IF NOT EXISTS idx_dav_replications_due ON dav_replications(enabled, last_run_at);
CREATE INDEX IF NOT EXISTS idx_dav_replications_volume ON dav_replications(volume_id);

-- Audit trail for `keep-both` resolutions and for every propagated deletion.
-- A two-way sync that deletes on both sides is the most dangerous thing this
-- codebase does, and "which side won, and what was kept" is the first question
-- anyone asks afterwards.
CREATE TABLE IF NOT EXISTS dav_replication_conflicts (
  conflict_id     TEXT PRIMARY KEY,
  replication_id  TEXT NOT NULL,
  path            TEXT NOT NULL,
  -- 'local' when the Durable-DAV version won, 'remote' when the remote's did.
  winner          TEXT NOT NULL CHECK(winner IN ('local', 'remote')),
  -- For 'keep-both', the sibling copy actually written. Null for 'sync', where
  -- the loser is discarded.
  kept_path       TEXT,
  -- 'conflict'   → both sides changed; resolved by mode.
  -- 'deletion'   → one side deleted a path the other still had, and the gate
  --                allowed it through. Recorded so every propagated delete is
  --                attributable after the fact.
  kind            TEXT NOT NULL DEFAULT 'conflict' CHECK(kind IN ('conflict', 'deletion')),
  detected_at     INTEGER NOT NULL,
  resolved_at     INTEGER,
  FOREIGN KEY (replication_id) REFERENCES dav_replications(replication_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dav_replication_conflicts_replication ON dav_replication_conflicts(replication_id, detected_at);
