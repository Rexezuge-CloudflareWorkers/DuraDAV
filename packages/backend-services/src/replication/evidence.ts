/**
 * The comparisons the sync decision rests on.
 *
 * Split from `buildReplicationPlan` so each rule can be read — and tested — on
 * its own. They are the whole safety argument: every one of them is conservative
 * in the same direction, resolving missing evidence to "changed" rather than
 * "unchanged", because a false *unchanged* suppresses a real edit while a false
 * *changed* costs one redundant transfer.
 */

import { CryptoUtil } from '@durable-dav/shared/utils';
import type { PlanSide, ReplicationMode } from './types';

/**
 * Total order on paths, for reproducible decision ordering.
 *
 * Plain code-unit comparison rather than `localeCompare`: the order only has to
 * be *stable*, and a locale-dependent comparator would order two runs differently
 * under different ICU data — which would make a conflict's winner depend on the
 * environment.
 */
function compareByPath(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Has this side changed since the base was recorded?
 *
 * Conservative in one direction only. Any missing evidence — a server that
 * sends no ETag, a collection with no `getlastmodified` — answers "changed",
 * because the cost of a false *changed* is one redundant transfer and the cost
 * of a false *unchanged* is a lost edit.
 */
function sideChanged(
  current: { etag: string | null; mtime: number | null; size: number | null; isCollection: boolean },
  base: { etag: string | null; mtime: number | null; size: number | null; isCollection: boolean },
): boolean {
  if (current.isCollection !== base.isCollection) return true;
  if (current.etag !== null && base.etag !== null) return current.etag !== base.etag || current.size !== base.size;
  if (current.mtime !== null && base.mtime !== null) return current.mtime !== base.mtime || current.size !== base.size;
  // No evidence either way, so "changed". A false *changed* costs one redundant
  // transfer; a false *unchanged* costs a lost edit.
  return current.size === null || base.size === null || current.size !== base.size;
}

/**
 * Equal size and equal timestamp, with both present on each side.
 *
 * Written as one expression over destructured locals on purpose: the chained
 * `!== null && … === …` form reads as a single fact but reads *four* to the
 * linter's narrowing analysis, and splitting it into guards trips the rule that
 * then wants it folded back into a ternary.
 */
function sameSizeAndTime(a: PlanSide, b: PlanSide): boolean {
  const { size: sizeA, mtime: timeA } = a;
  const { size: sizeB, mtime: timeB } = b;
  // `no-redundant-comparison` reads the null guards as implying the equality
  // below, which they do not: "both present" and "both present *and equal*" are
  // different facts, and conflating them would call every same-size pair
  // identical.
  // eslint-disable-next-line unicorn/no-redundant-comparison
  return sizeA !== null && sizeB !== null && timeA !== null && timeB !== null && sizeA === sizeB && timeA === timeB;
}

/**
 * Do these two observations provably describe the same bytes?
 *
 * Only ever answers *yes* on positive evidence. `null` means "cannot tell", and
 * the caller decides what to do with that — never silently reads as a match.
 */
function provablyIdentical(a: PlanSide, b: PlanSide): boolean {
  if (a.isCollection !== b.isCollection) return false;
  // Collections carry no validator worth comparing; two collections at the same
  // path are the same collection.
  //
  // `prefer-ternary` is disabled on this function only: it wants the three
  // evidence tiers folded into one nested ternary, which is exactly the shape that
  // made the original version hard to check by eye. Stated flat, each tier is one
  // line and the order — strong validator, then timestamp, then nothing — is the
  // order of trust.
  if (a.isCollection) return true;
  // Strong validator first; size+timestamp only as the fallback for servers that
  // send no ETag.
  if (a.etag === null || b.etag === null) return sameSizeAndTime(a, b);
  // eslint-disable-next-line unicorn/prefer-ternary -- see above.
  return a.etag === b.etag && a.size === b.size;
}

/**
 * Same size on the same side — used to decide whether hashing both sides is worth
 * the two reads it costs.
 */
function couldBeIdentical(a: PlanSide, b: PlanSide): boolean {
  if (a.isCollection !== b.isCollection) return false;
  // eslint-disable-next-line unicorn/prefer-ternary -- see `provablyIdentical`.
  if (a.isCollection) return true;
  const { size: sizeA } = a;
  const { size: sizeB } = b;
  // Same reasoning as `sameSizeAndTime`, minus the timestamp: this one only
  // decides whether a hash is worth performing.
  // eslint-disable-next-line unicorn/no-redundant-comparison
  return sizeA !== null && sizeB !== null && sizeA === sizeB;
}

const MAX_CONFLICT_STEM_LENGTH = 180;

/**
 * `<name>.conflict-<seconds>` in the same parent directory.
 *
 * Sibling rather than a `conflict/` subtree so the copy is visible next to the
 * original — a user resolving a conflict is looking at the directory, not
 * hunting through a tree. Stem is truncated rather than rejected: a name at the
 * length limit plus a suffix would be rejected by `MAX_PATH_DEPTH`'s sibling,
 * and dropping the user's file because its name is long would be a worse
 * outcome than shortening it.
 */
function conflictPathFor(path: string, taken: ReadonlySet<string>, nowSeconds: number): string {
  const slash = path.lastIndexOf('/');
  const parent = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const stem = name.length > MAX_CONFLICT_STEM_LENGTH ? name.slice(0, MAX_CONFLICT_STEM_LENGTH) : name;
  const base = `${parent}${stem}.conflict-${nowSeconds}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${CryptoUtil.randomBase64Url(4)}`;
}

/**
 * Which side wins a genuine conflict.
 *
 * `sync` compares mtimes, which is a *tiebreak* and not a guarantee: the two
 * values come from two different clocks, and a remote whose clock is an hour
 * fast wins every argument. It is still the only signal a portable WebDAV peer
 * offers. When it cannot decide — equal times, or a side with no usable mtime —
 * it returns `null`, and the caller falls back to `keep-both` rather than
 * picking. Silently resolving a tie by iteration order would be the one outcome
 * nobody could debug.
 */
function conflictWinner(local: PlanSide, remote: PlanSide, mode: ReplicationMode): 'local' | 'remote' | null {
  if (mode === 'copy-only') return 'local';
  if ((mode === 'keep-both') || local.mtime === null || remote.mtime === null || (local.mtime === remote.mtime)) return null;
  return local.mtime > remote.mtime ? 'local' : 'remote';
}

export { compareByPath, conflictPathFor, sideChanged, provablyIdentical, couldBeIdentical, conflictWinner };
