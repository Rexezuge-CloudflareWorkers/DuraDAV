import type { D1Queryable } from '../utils';

/**
 * The sweep's pass bookkeeping, as statements.
 *
 * Split from `DavReplicationDAO` because `pass_started_at` is not a column like the
 * others: it is the **deletion gate**, and the rules for when it opens and closes are
 * the whole safety argument of the sync engine. They are stated once here, next to the
 * SQL that implements them, rather than spread across three DAO methods where a reader
 * has to hold all three in their head to know whether a deletion will fire.
 *
 * ## The gate
 *
 * `pass_started_at IS NOT NULL` means "this pass has not finished visiting the tree".
 * While it is set, an absence is not evidence of anything, so `buildReplicationPlan`
 * defers every absence-based decision. It is opened by `beginPass` and closed by
 * `recordRun` when the pass *failed* or *finished with nothing left to visit* — and
 * deliberately left open by a clean pass that still has queued collections.
 *
 * That last case is the one that was wrong first time round: the column was cleared only
 * on failure, so a healthy replication left it set forever, the gate stayed shut for the
 * life of the target, and deletions never propagated at all — on the one configuration
 * where everything else was working.
 */

type ReplicationRunStatus = 'ok' | 'partial' | 'failed';

const MAX_STORED_ERROR_LENGTH = 500;

/**
 * Open a pass, and park any cursor a previous pass left behind.
 *
 * Clearing the cursor is not optional: a stale resumption point is worse than none,
 * because it would skip everything before the stale position and report the sweep
 * complete — deleting nothing and believing it had reached the end.
 */
function beginPassStatement(database: D1Queryable, replicationId: string, now: number) {
  return database
    .prepare('UPDATE dav_replications SET pass_started_at = ?, cursor_path = NULL, cursor_remaining = 0, updated_at = ? WHERE replication_id = ?')
    .bind(now, now, replicationId)
    .run();
}

/**
 * Park the sweep position between ticks.
 *
 * `cursorRemaining` is a count of paths still to visit, not a byte estimate: it is the
 * only number available before the slice has read anything, and the staleness guard
 * compares it against zero to decide whether the pass ended cleanly.
 */
function advanceCursorStatement(database: D1Queryable, replicationId: string, cursorPath: string | null, remaining: number, now: number) {
  return database
    .prepare('UPDATE dav_replications SET cursor_path = ?, cursor_remaining = ?, updated_at = ? WHERE replication_id = ?')
    .bind(cursorPath, remaining, now, replicationId)
    .run();
}

/**
 * Record the outcome of one tick, and open or close the gate accordingly.
 *
 * The auto-disable is one statement on purpose: a read-then-write would race two
 * concurrent ticks against each other and let both see `consecutive_failures = max - 1`
 * and each decide it was the last straw.
 */
function recordRunStatement(
  database: D1Queryable,
  replicationId: string,
  status: ReplicationRunStatus,
  error: string | null,
  now: number,
  maxFailures: number,
  cursorPath: string | null,
  remaining: number,
) {
  const failed = status !== 'ok';
  // A pass is closed when it failed, or when it finished with nothing left to visit. A
  // clean pass that still has queued collections leaves the gate shut — that is the
  // entire mechanism.
  const closePass = !failed || remaining === 0;
  const trimmedError = error === null ? null : error.slice(0, MAX_STORED_ERROR_LENGTH);
  return database
    .prepare(
      `UPDATE dav_replications SET
         last_run_at = ?,
         last_status = ?,
         last_error = ?,
         consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END,
         enabled = CASE WHEN ? AND consecutive_failures + 1 >= ? THEN 0 ELSE enabled END,
         pass_started_at = CASE WHEN ? THEN NULL ELSE pass_started_at END,
         cursor_path = ?,
         cursor_remaining = ?,
         updated_at = ?
       WHERE replication_id = ?`,
    )
    .bind(now, status, trimmedError, failed ? 1 : 0, failed ? 1 : 0, maxFailures, closePass ? 1 : 0, cursorPath, remaining, now, replicationId)
    .run();
}

export { advanceCursorStatement, beginPassStatement, recordRunStatement };
