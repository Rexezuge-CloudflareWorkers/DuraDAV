import type { DirEntry, DofsFs } from '@durable-dav/dav-store';
import { fsPathOf } from './DavContext';

/**
 * How a `dofs` read failure is answered, and why that choice belongs in one place.
 *
 * ## Why this is a type and not a naming convention
 *
 * A `dofs` read can fail for two very different reasons, and a caller often
 * cannot tell them apart from the value it got back:
 *
 * - **absence** — the path is not there. An answer, and usually the one wanted.
 * - **inability** — the read could not be performed. Not an answer at all.
 *
 * When both are rendered as "nothing here", any caller that reads *absences* acts
 * on a storage fault as though it were a deletion. That is the most destructive
 * confusion in this codebase and it has shipped twice: a `Depth: infinity` lock
 * query degrading to "no locks", and a replication collection listing degrading
 * to "this collection is empty" — which queues the deletion of everything in it.
 *
 * So the policy is stated in exactly one place, as a parameter to the four reads
 * below, and `DavRepository` exposes only named wrappers over them. Four
 * hand-written methods differing in a `try`/`catch` had drifted apart before; one
 * primitive per read cannot drift from itself.
 *
 * ## The two policies
 *
 * - `'degrade'` — answer with a benign-looking empty value (`[]`, `0`,
 *   `exists: false`). Correct for rendering a collection, and for a fresh volume
 *   whose metadata row does not exist yet.
 * - `'throw'` — let the failure surface. The only safe answer for a caller that
 *   will *act on an absence*: it then fails closed instead of deleting, pulling,
 *   or overwriting on evidence that does not exist.
 *
 * ## Absence is not failure
 *
 * `dofs` reports a missing path as a thrown `ENOENT`, so under both policies that
 * one case is separated out and answered as "not there". This matters most for the
 * throwing variants: a replication's first listing of a configured `remotePath`
 * asks about a subdirectory that has never been created, and that is a normal
 * state — treating it as a fault would fail every first sync.
 */

/**
 * How a failed read is answered.
 *
 * - `'degrade'` — substitute a benign empty value and carry on.
 * - `'throw'` — propagate, so the caller cannot mistake the failure for content.
 */
export type ReadFailure = 'degrade' | 'throw';

/**
A stat that found the resource. Narrower than `StatResult` on purpose.
*/
export type FoundStat = {
  exists: true;
  isDirectory: boolean;
  size: number;
  mtime: number;
};

export type StatResult = Omit<FoundStat, 'exists'> & { exists: boolean };

export const MISSING_STAT: StatResult = { exists: false, isDirectory: false, size: 0, mtime: 0 };

/**
 * Whether a failed read means "not there" rather than "could not tell".
 *
 * Narrow deliberately. `ENOENT` and `no such file` are the spellings dofs and the
 * platform's FS layer produce. A loose `/not\s+found/i` would also match
 * `host not found` — a DNS blip — and classifying that as "the file is gone" is
 * exactly the conflation this module exists to prevent. (The same reasoning is
 * applied to D1 errors in `backend-data`'s `D1ErrorClassifier`, which also had to
 * narrow `/range/i` away from `RangeError: Maximum call stack size exceeded`.)
 */
function isMissingPath(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT/.test(message) || /no such file/i.test(message);
}

/**
 * Reads over `dofs` under one failure policy.
 *
 * Owns the `ENOENT` split so no caller has to, and exists as a collaborator rather
 * than as private methods so the policy is testable on its own and the repository
 * stays about SQL.
 */
export class DavReadPolicy {
  constructor(private readonly dofs: DofsFs) {}

  /**
   * `stat`, with absence separated from inability.
   *
   * A path that is genuinely not there answers `MISSING_STAT` under both policies:
   * `dofs` cannot tell a caller "absent" any other way, and the sync engine has to
   * be able to receive that answer.
   */
  public stat(innerPath: string, onFailure: ReadFailure): StatResult {
    try {
      const st = this.dofs.stat(fsPathOf(innerPath));
      return { exists: true, isDirectory: st.isDirectory, size: st.size ?? 0, mtime: st.mtime ?? Date.now() };
    } catch (error) {
      if (isMissingPath(error)) return MISSING_STAT;
      if (onFailure === 'throw') throw error;
      return MISSING_STAT;
    }
  }

  /**
   * Direct children (`recursive: false`) or the whole subtree, with `.` and `..`
   * dropped — dofs includes them and they are not addressable resources.
   *
   * A collection that does not exist answers `[]` under both policies, for the
   * first-sync reason in the module header.
   */
  public list(innerPath: string, recursive: boolean, onFailure: ReadFailure): string[] {
    try {
      return this.dofs.listDir(fsPathOf(innerPath), { recursive }).filter((name) => name !== '.' && name !== '..');
    } catch (error) {
      if (isMissingPath(error)) return [];
      if (onFailure === 'throw') throw error;
      return [];
    }
  }

  /**
   * One page of direct children as `{name, isDirectory}`.
   *
   * Separate from `list` because a pager must not materialise every name: this is
   * the indexed `(parent, name)` read, and the trailing binary `name` in its
   * `ORDER BY` is load-bearing — `NOCASE` alone is not a total order, and a
   * non-deterministic tiebreak puts an entry on two pages or on none.
   *
   * `listChildren` cannot back a pager: it materialises every name from one
   * unbounded scan and discards the `is_dir` column that scan already reads, so
   * ordering collections-first would cost a `stat` per name. This carries
   * `isDirectory` out of the same query and stops at the page boundary.
   */
  public listPage(innerPath: string, offset: number, limit: number, onFailure: ReadFailure): DirEntry[] {
    try {
      return this.dofs.listDirPage(fsPathOf(innerPath), { offset, limit });
    } catch (error) {
      if (isMissingPath(error)) return [];
      if (onFailure === 'throw') throw error;
      return [];
    }
  }

  /**
   * Total direct children, for a paged `Depth: 1` multistatus's page count and its
   * last-page clamp.
   *
   * `COUNT(*)` over `idx_dofs_files_parent` rather than `list().length`, which
   * would read every row to count it.
   */
  public countChildren(innerPath: string, onFailure: ReadFailure): number {
    try {
      return this.dofs.countChildren(fsPathOf(innerPath));
    } catch (error) {
      if (isMissingPath(error)) return 0;
      if (onFailure === 'throw') throw error;
      return 0;
    }
  }
}
