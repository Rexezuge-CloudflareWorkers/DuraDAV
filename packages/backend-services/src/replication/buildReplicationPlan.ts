/**
 * The three-way sync decision, as a pure function.
 *
 * Everything destructive in replication is decided here, and nothing here performs
 * I/O. That is deliberate: the failure modes worth designing against — silently
 * overwriting a file, propagating a deletion that was really a truncated listing,
 * importing a mirror's own corruption — are all *decision* bugs, and a decision
 * exercisable as a plain function over three arrays is testable in a way that a
 * runner talking to two servers is not.
 *
 * The comparisons it leans on are in `evidence`, the shapes in `types`, and the
 * I/O that feeds it is in `apps/background/src/replication`.
 */

import { compareByPath, conflictPathFor, conflictWinner, couldBeIdentical, provablyIdentical, sideChanged } from './evidence';
import type { BuildPlanInput, ReplicationDecision, ReplicationPlan } from './types';

/**
 * A decision plus the ordering key it is sorted on.
 *
 * Ordering is part of the decision, not an afterthought: a pull that writes
 * `a/b/c.txt` needs `a` and `a/b` to exist first, and a recursive delete has to
 * empty a subtree before removing its parent. Both are encoded here so the sort at
 * the end is one statement rather than a second pass with its own bugs.
 */
/**
 * Index observations by path.
 *
 * First writer wins: a duplicate path means the caller handed us two entries for
 * one resource, and silently taking the last would let enumeration order decide
 * the outcome.
 */
function indexByPath<T extends { path: string }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    if (row.path !== '' && !out.has(row.path)) out.set(row.path, row);
  }
  return out;
}

type Ordered = {
  decision: ReplicationDecision;
  isCollection: boolean;
  depth: number;
  order: number;
};

/**
 * Walk the three views and decide, then order the result.
 */
function buildReplicationPlan(input: BuildPlanInput): ReplicationPlan {
  const local = indexByPath(input.local);
  const remote = indexByPath(input.remote);
  const base = indexByPath(input.base);
  const now = input.now ?? 0;
  const nowSeconds = Math.floor(now / 1000);
  const pullOnly = input.mode === 'pull-only';
  const mirrorDeletions = input.mirrorDeletions === true;

  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...base.keys()]);
  // Both trees plus every reserved conflict name, so a generated conflict path
  // can never land on a resource that already exists.
  const taken = new Set<string>(paths);

  const deferredPaths: string[] = [];
  const conflicts: Array<{ path: string; winner: 'local' | 'remote'; kind: 'conflict' | 'deletion'; conflictPath: string | null }> = [];
  /**
   * Every decision, tagged for the ordering pass.
   *
   * All of them live here rather than partly in a side array: `forget` was
   * originally pushed straight to a `decisions` list that the sort never read,
   * so every "gone from both sides" path silently vanished from the plan and its
   * base row was never dropped.
   */
  const pending: Ordered[] = [];

  let order = 0;
  const emit = (decision: ReplicationDecision, isCollection: boolean): void => {
    pending.push({ decision, isCollection, depth: decision.path.split('/').length, order: order++ });
  };

  for (const path of [...paths].sort(compareByPath)) {
    const l = local.get(path);
    const r = remote.get(path);
    const b = base.get(path);

    // --- Absent from both sides -------------------------------------------
    if (l === undefined && r === undefined) {
      if (b === undefined) continue;
      // Both sides agreeing a path is gone is *still* an absence, and it is the
      // one most easily produced by a listing that never happened. Acting on it
      // drops the base row, and with it the only record that the file existed —
      // after which the next pass treats the remote's copy as brand new and
      // pushes over it. So an untrusted absence decides nothing, here as anywhere.
      if (!input.trustAbsences) {
        deferredPaths.push(path);
        continue;
      }
      // Gone from both trees: the deletion already reached everywhere, so there
      // is nothing left to propagate — only the stale record to drop. Distinct
      // from a deletion *pending* propagation, which is the one-sided case below.
      emit({ kind: 'forget', path }, false);
      continue;
    }

    // --- Present on exactly one side, never seen before --------------------
    if (b === undefined) {
      if (l !== undefined && r === undefined) {
        // `pull-only` is the one mode that never creates a remote resource. A new
        // local file is either removed (mirror) or left in place, and in the second
        // case nothing is emitted at all — recording a base for it would make the
        // next pass see "unchanged" and forget it was ever ignored.
        if (pullOnly) {
          if (mirrorDeletions && input.trustAbsences) {
            conflicts.push({ path, winner: 'remote', kind: 'deletion', conflictPath: null });
            emit({ kind: 'delete-local', path }, false);
          }
          continue;
        }
        // New locally. Push in every other mode, including `copy-only`: a mirror
        // that refuses to accept new files is not a mirror.
        emit({ kind: 'push', path, contentType: l.contentType }, l.isCollection);
        continue;
      }
      if (l === undefined && r !== undefined) {
        if (input.mode === 'copy-only') continue;
        emit({ kind: 'pull', path, contentType: r.contentType }, r.isCollection);
        continue;
      }
      // Both sides created it independently. Reaching here means neither is
      // undefined — the two branches above are exhaustive — but TypeScript cannot
      // see that through `continue`, so the narrowing is asserted once.
      if (l === undefined || r === undefined) continue;
      if (provablyIdentical(l, r)) {
        emit({ kind: 'agree', path, isCollection: l.isCollection, contentType: l.contentType }, l.isCollection);
        continue;
      }
      const winner = conflictWinner(l, r, input.mode);
      // `pull-only` cannot fall back to `keep-both` (its `conflictWinner` is never
      // `null`), and the hash comparison is skipped rather than deferred: both sides
      // being "new" means neither has a base, so the remote's authority already
      // settles it and the local bytes are preserved either way.
      if (!pullOnly && input.hashOnAmbiguous === true && couldBeIdentical(l, r)) {
        emit({ kind: 'compare-content', path, winner: 'local' }, l.isCollection);
        continue;
      }
      if (winner === null) {
        const conflictPath = conflictPathFor(path, taken, nowSeconds);
        taken.add(conflictPath);
        conflicts.push({ path, winner: 'local', kind: 'conflict', conflictPath });
        emit({ kind: 'keep-both', path, winner: 'local', conflictPath }, l.isCollection || r.isCollection);
        continue;
      }
      // Both sides created it and the remote is the authority: keep the local one
      // beside the path rather than overwriting it with a version this bucket never
      // had a say in.
      if (winner === 'remote' && pullOnly) {
        const conflictPath = conflictPathFor(path, taken, nowSeconds);
        taken.add(conflictPath);
        conflicts.push({ path, winner, kind: 'conflict', conflictPath });
        emit({ kind: 'pull-and-preserve', path, conflictPath, contentType: l.contentType }, l.isCollection || r.isCollection);
        continue;
      }
      conflicts.push({ path, winner, kind: 'conflict', conflictPath: null });
      emit(
        winner === 'local' ? { kind: 'push', path, contentType: l.contentType } : { kind: 'pull', path, contentType: r.contentType },
        winner === 'local' ? l.isCollection : r.isCollection,
      );
      continue;
    }

    // --- Seen before, present on exactly one side: a deletion ---------------
    if (l === undefined || r === undefined) {
      if (!input.trustAbsences) {
        // The base row is left untouched on purpose. It is the only remaining
        // evidence that this path existed and was deleted, so clearing it here
        // would make the deletion unrecoverable rather than merely deferred.
        deferredPaths.push(path);
        continue;
      }
      if (pullOnly) {
        // The remote is the authority, so its view of a deletion wins and the local
        // copy is the one removed — but only when the owner asked for an exact
        // mirror. Without `mirrorDeletions` this emits nothing at all, and that is
        // the safe-copy behaviour rather than an oversight: a remote that has lost
        // or never received a file must not be able to delete the copy the owner
        // still has.
        //
        // A local deletion with the remote still holding it is the other half: the
        // remote is authoritative, so the file comes back down rather than being
        // propagated upward. Nothing is ever pushed in this mode.
        if (l === undefined) {
          emit({ kind: 'pull', path, contentType: r?.contentType ?? null }, r?.isCollection ?? false);
          continue;
        }
        if (!mirrorDeletions) continue;
        conflicts.push({ path, winner: 'remote', kind: 'deletion', conflictPath: null });
        emit({ kind: 'delete-local', path }, false);
        continue;
      }
      // The absent side is the one that *deleted* it, so the deletion has to be
      // applied to the side that still has it. Getting this backwards deletes the
      // only surviving copy: a local `DELETE` would remove the remote's file and
      // leave nothing anywhere.
      const side = l === undefined ? 'delete-remote' : 'delete-local';
      // `winner` records which side *survives*, so the audit row reads correctly:
      // a propagated local deletion leaves the remote's version as the survivor
      // until this operation lands.
      conflicts.push({ path, winner: l === undefined ? 'remote' : 'local', kind: 'deletion', conflictPath: null });
      emit({ kind: side, path }, false);
      continue;
    }

    // --- Seen before, present on both sides: the three-way comparison -------
    // Both sides are defined here: the absent-both branch and the one-sided
    // deletion branch above each `continue`.
    const localChanged = sideChanged(l, { etag: b.localEtag, mtime: b.localMtime, size: b.localSize, isCollection: b.isCollection });
    const remoteChanged = sideChanged(r, { etag: b.remoteEtag, mtime: b.remoteMtime, size: b.remoteSize, isCollection: b.isCollection });

    if (!localChanged && !remoteChanged) {
      emit({ kind: 'agree', path, isCollection: l.isCollection, contentType: b.contentType ?? l.contentType }, l.isCollection);
      continue;
    }
    if (localChanged && !remoteChanged) {
      // A local-only change under `pull-only` is a real edit that the remote never
      // made, and overwriting it with the remote's version would discard work. It is
      // preserved beside the path first, so "the remote is authoritative" never means
      // "the owner's edit is gone" — the same guarantee `keep-both` gives, without a
      // write to the remote.
      if (pullOnly) {
        const conflictPath = conflictPathFor(path, taken, nowSeconds);
        taken.add(conflictPath);
        conflicts.push({ path, winner: 'remote', kind: 'conflict', conflictPath });
        emit({ kind: 'pull-and-preserve', path, conflictPath, contentType: l.contentType }, l.isCollection);
        continue;
      }
      emit({ kind: 'push', path, contentType: l.contentType }, l.isCollection);
      continue;
    }
    if (!localChanged && remoteChanged) {
      // `copy-only` ignores remote changes entirely: the remote is a mirror,
      // and importing from it would let a corrupted copy overwrite the original.
      if (input.mode === 'copy-only') {
        emit({ kind: 'agree', path, isCollection: l.isCollection, contentType: l.contentType }, l.isCollection);
        continue;
      }
      emit({ kind: 'pull', path, contentType: r.contentType }, r.isCollection);
      continue;
    }

    // Both changed.
    if (provablyIdentical(l, r)) {
      emit({ kind: 'agree', path, isCollection: l.isCollection, contentType: l.contentType }, l.isCollection);
      continue;
    }
    const winner = conflictWinner(l, r, input.mode);
    if (winner === null) {
      // Undecidable — `keep-both`, never a coin flip. Same rule as above.
      const conflictPath = conflictPathFor(path, taken, nowSeconds);
      taken.add(conflictPath);
      conflicts.push({ path, winner: 'local', kind: 'conflict', conflictPath });
      emit({ kind: 'keep-both', path, winner: 'local', conflictPath }, l.isCollection);
      continue;
    }
    // `pull-only` resolves at this point too, since `conflictWinner` names the
    // remote. Both sides changed and the remote is the authority, so its version
    // wins — with the local one preserved locally rather than copied across.
    if (winner === 'remote' && pullOnly) {
      const conflictPath = conflictPathFor(path, taken, nowSeconds);
      taken.add(conflictPath);
      conflicts.push({ path, winner, kind: 'conflict', conflictPath });
      emit({ kind: 'pull-and-preserve', path, conflictPath, contentType: l.contentType }, l.isCollection);
      continue;
    }
    if (input.hashOnAmbiguous === true && couldBeIdentical(l, r)) {
      emit({ kind: 'compare-content', path, winner }, l.isCollection);
      continue;
    }
    conflicts.push({ path, winner, kind: 'conflict', conflictPath: null });
    if (winner === 'local') {
      emit({ kind: 'push', path, contentType: l.contentType }, l.isCollection);
    } else {
      emit({ kind: 'pull', path, contentType: r.contentType }, r.isCollection);
    }
  }

  // Apply the ordering: collections first, then shallower before deeper, then
  // bookkeeping, then deletions deepest-first so a subtree empties before its
  // parent is removed.
  pending.sort((a, b) => (a.isCollection === b.isCollection ? a.depth - b.depth || a.order - b.order : a.isCollection ? -1 : 1));
  const isDeletion = (entry: Ordered): boolean => entry.decision.kind === 'delete-local' || entry.decision.kind === 'delete-remote';
  const deletions = pending.filter(isDeletion);
  // Deepest first, so a subtree empties before its parent is removed. A server
  // that refuses to delete a non-empty collection would otherwise fail the parent
  // and wedge the sweep on it forever.
  deletions.sort((a, b) => b.depth - a.depth || a.order - b.order);
  const rest = pending.filter((entry) => !isDeletion(entry));

  return {
    decisions: [...rest, ...deletions].map((entry) => entry.decision),
    deferredPaths,
    conflicts,
    absencesDeferred: deferredPaths.length > 0,
  };
}

export { buildReplicationPlan };
