/**
 * Truncating a replication error for storage or display.
 *
 * Four modules capped an error string independently — `PlanExecutor` at 300,
 * `ReplicationRunner` at 500, `VolumeReplicationRpc` at 300, and
 * `replicationPassSql` at 500 *on a string the caller had already truncated*.
 * Two constants and a redundant re-truncation is exactly the shape of bug that
 * makes "which limit applies here" unanswerable from the call site, so the cap
 * is stated once.
 *
 * ## Why the audit trail needs its own, larger cap
 *
 * `last_error` is shown to the owner in the UI and is the only record of *why* a
 * pass failed. It is worth more characters than a per-file diagnostic, so it
 * gets the larger limit. The smaller `TRUNCATED_ERROR_LENGTH` is for the
 * in-flight log line and for the per-resource reason inside a `207`.
 */

/**
For `dav_replications.last_error` — the owner's audit trail.
*/
const STORED_ERROR_LENGTH = 500;

/**
For a per-resource diagnostic inside a `207` multistatus.
*/
const TRUNCATED_ERROR_LENGTH = 300;

/**
 * Clamp to `STORED_ERROR_LENGTH`.
 *
 * Idempotent, so applying it at both the producing and the storing end is
 * harmless rather than a second, subtly different rule.
 */
function truncateReplicationError(message: string): string {
  return message.length > STORED_ERROR_LENGTH ? message.slice(0, STORED_ERROR_LENGTH) : message;
}

/**
 * Clamp to `TRUNCATED_ERROR_LENGTH` — the tighter cap, for a reason a client
 * sees in a single `207` rather than a value the owner reads later.
 */
function truncateReplicationReason(message: string): string {
  return message.length > TRUNCATED_ERROR_LENGTH ? message.slice(0, TRUNCATED_ERROR_LENGTH) : message;
}

/**
`error` as the single-line string both caps are applied to.
*/
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { errorMessageOf, truncateReplicationError, truncateReplicationReason, STORED_ERROR_LENGTH, TRUNCATED_ERROR_LENGTH };