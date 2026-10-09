/**
 * The wire shape of a replication, and the body a create request carries.
 *
 * Split from `ReplicationRoutes` so the projection can be read in one place. It is the
 * only thing standing between a stored credential and a client, so it deserves to be
 * checkable on its own: every field named here is a field a client sees, and anything
 * *not* named here is not sent. A projection that grew by copying the row would publish
 * `encrypted_secret` the first time someone added a column.
 */

/**
The projection a client sees. Never includes `encrypted_secret`/`secret_iv`.
*/
function toReplicationJson(row: {
  replication_id: string;
  target_kind: string;
  remote_url: string;
  remote_owner: string;
  remote_volume: string;
  remote_path: string;
  auth_kind: string;
  mode: string;
  mirror_deletions: number;
  interval_minutes: number;
  enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  pass_started_at: number | null;
  created_at: number;
  updated_at: number;
}): Record<string, unknown> {
  return {
    replicationId: row.replication_id,
    targetKind: row.target_kind,
    // For a sibling bucket the "URL" is its path, which is what the UI needs to
    // render the target; a third-party server's URL is shown as configured.
    remoteUrl: row.remote_url,
    remoteOwner: row.remote_owner,
    remoteVolume: row.remote_volume,
    remotePath: row.remote_path,
    authKind: row.auth_kind,
    mode: row.mode,
    // Only meaningful for 'pull-only', and always sent so the client can render the
    // state it is in rather than inferring it from an absent field.
    mirrorDeletions: row.mirror_deletions === 1,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    /**
    Non-null means a pass is open, which is also the deletion gate.
    */
    passInFlight: row.pass_started_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
The decision trail, in the same spirit: a `keptPath` is the only place a losing version
survives, so a client that cannot see it cannot resolve the conflict it is being told
about. No `replicationId` — the client is already scoped to one replication's conflicts.
*/
function toConflictJson(row: {
  conflict_id: string;
  path: string;
  winner: string;
  kept_path: string | null;
  kind: string;
  detected_at: number;
  resolved_at: number | null;
}): Record<string, unknown> {
  return {
    conflictId: row.conflict_id,
    path: row.path,
    winner: row.winner,
    keptPath: row.kept_path,
    kind: row.kind,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
  };
}

export { toConflictJson, toReplicationJson };
