/**
 * The shapes the sync planner speaks in.
 *
 * `PlanSide` is one resource as *observed* — on either side — and `PlanBase` is
 * what both sides looked like the last time they agreed. Those are the only two
 * views the decision needs, and keeping them as plain data rather than as objects
 * with methods is what lets the whole decision be a pure function over three
 * arrays.
 *
 * The reasoning behind the decision itself lives in `buildReplicationPlan`, and
 * the comparisons it relies on in `evidence`.
 */

/**
 * How a path both sides changed is reconciled, and in which direction changes flow
 * at all. The mode is the whole conflict policy — there is no separate direction
 * setting, because "never imports" and "always wins" have to be one decision.
 *
 * - `copy-only`  — Durable-DAV is the sole writer. The remote is a mirror.
 * - `sync`       — both directions; a genuine conflict resolves by `mtime`.
 * - `keep-both`  — both directions; a conflict never overwrites, it writes a sibling
 *                  copy and records the row.
 * - `pull-only`  — the *remote* is the sole writer. The mirror image of
 *                  `copy-only`, and the one mode in which nothing is ever pushed.
 */
type ReplicationMode = 'copy-only' | 'sync' | 'keep-both' | 'pull-only';

type PlanSide = {
  path: string;
  isCollection: boolean;
  etag: string | null;
  /**
   * Epoch milliseconds. May come from the *remote server's* clock, which is why it
   * is a tiebreak rather than a guarantee.
   */
  mtime: number | null;
  size: number | null;
  contentType: string | null;
};

type PlanBase = {
  path: string;
  isCollection: boolean;
  localEtag: string | null;
  localMtime: number | null;
  localSize: number | null;
  remoteEtag: string | null;
  remoteMtime: number | null;
  remoteSize: number | null;
  contentType: string | null;
};

type ReplicationDecision =
  /**
  Move the local version to the remote.
  */
  | { kind: 'push'; path: string; contentType: string | null }
  /**
  Bring the remote version down.
  */
  | { kind: 'pull'; path: string; contentType: string | null }
  /**
  Remove from the remote. Gated on `trustAbsences`.
  */
  | { kind: 'delete-remote'; path: string }
  /**
  Remove locally. Gated on `trustAbsences`.
  */
  | { kind: 'delete-local'; path: string }
  /**
  Both sides changed. `conflictPath` is where the losing side is preserved.
  */
  | { kind: 'keep-both'; path: string; winner: 'local' | 'remote'; conflictPath: string }
  /**
  * `pull-only` only: the remote's version wins, and the local version that would
  * have been overwritten is preserved at `conflictPath` **on the local side**.
  *
  * A distinct kind rather than `keep-both` with `winner: 'remote'`, because
  * `PlanExecutor.keepBoth` writes the loser's bytes into *both* sides' conflict
  * slots — and under `pull-only` the remote must never be written at all. Reusing
  * the existing kind would push a local edit to a target whose whole definition is
  * that it is not written to.
  */
  | { kind: 'pull-and-preserve'; path: string; conflictPath: string; contentType: string | null }
  /**
  Sizes match but the validators do not; the runner hashes before deciding.
  */
  | { kind: 'compare-content'; path: string; winner: 'local' | 'remote' }
  /**
  Both sides are in agreement — refresh the recorded base, transfer nothing.
  */
  | { kind: 'agree'; path: string; isCollection: boolean; contentType: string | null }
  /**
  Absent from both sides and from the base. Nothing to do.
  */
  | { kind: 'forget'; path: string };

type ReplicationPlan = {
  decisions: ReplicationDecision[];
  /**
   * Paths whose absence could not be trusted, in path order.
   *
   * Reported so the runner can tell "nothing to do" from "could not see the whole
   * tree, so nothing was decided" — different states for the owner looking at a
   * remote that has visibly not changed.
   */
  deferredPaths: string[];
  /**
  Paths where both sides had changed. Recorded for the audit trail.
  */
  /**
   * Every decision worth explaining afterwards, with its kind *stated* rather than
   * inferred.
   *
   * The kind used to be derived by the runner from whether a conflict copy was
   * written, which conflated two unrelated things: a `sync` conflict resolved by
   * timestamp writes no copy (it discards the loser) and was therefore logged as a
   * `deletion`. This is the one place the feature promises to be trustworthy about
   * what it destroyed, so the decision names its own kind.
   */
  conflicts: Array<{ path: string; winner: 'local' | 'remote'; kind: 'conflict' | 'deletion'; conflictPath: string | null }>;
  /**
  `true` when at least one absence was held back rather than acted on.
  */
  absencesDeferred: boolean;
};

type BuildPlanInput = {
  mode: ReplicationMode;
  local: readonly PlanSide[];
  remote: readonly PlanSide[];
  base: readonly PlanBase[];
  /**
   * May an absence be treated as evidence?
   *
   * The caller sets this only when the pass could see the whole tree: every
   * collection in scope listed successfully and nothing errored since the pass
   * began.
   *
   * It gates **every** absence-based decision, not only deletions, and the
   * `forget` case is the reason. A failed listing makes one side look empty, so a
   * path absent from both sides reads as "deleted everywhere" — and answering that
   * by dropping its base row silently loses the record of a file that still
   * exists. The next pass would then see it as brand new and push over whatever
   * the remote has, which is precisely the overwrite this feature must never
   * perform. An untrusted absence therefore decides nothing at all.
   */
  trustAbsences: boolean;
  /**
   * Hash both sides when the validators disagree but the sizes match.
   *
   * Off by default. It costs two full reads of the file on every ambiguous pass,
   * and the alternative — treating "size matches" as "content matches" — silently
   * drops one side's edit, which is the outcome this whole feature exists to
   * prevent.
   */
  hashOnAmbiguous?: boolean;
  /**
   * `pull-only` only: may a local path the remote does not have be removed locally?
   *
   * `false` — the default, and every pre-0007 row — is the safe copy: the remote's
   * content is imported and kept current, and nothing local is ever destroyed.
   * `true` is an exact mirror, and every deletion it authorizes flows through the
   * same `trustAbsences` gate and the same `pass_started_at` gate as a two-way
   * deletion, so an incomplete listing cannot activate it either.
   *
   * Ignored in every other mode. `copy-only` already propagates local deletions to
   * the remote and `sync`/`keep-both` propagate in both directions, so there is
   * nothing here to add — and the service refuses `true` on those modes rather than
   * storing a flag that would mean nothing.
   */
  mirrorDeletions?: boolean;
  now?: number;
};

export type { ReplicationMode, PlanSide, PlanBase, ReplicationDecision, ReplicationPlan, BuildPlanInput };
