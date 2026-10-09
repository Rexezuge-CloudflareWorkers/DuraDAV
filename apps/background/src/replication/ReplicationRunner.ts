import { buildReplicationPlan } from '@durable-dav/backend-services/replication';
import type { ReplicationMode } from '@durable-dav/backend-services/replication';
import { DavReplicationConflictDAO, DavReplicationDAO } from '@durable-dav/backend-data/dao';
import type { DavReplicationRow } from '@durable-dav/backend-data/dao';
import { KvCache, invalidateDavVolumeCaches } from '@durable-dav/backend-runtime/kv';
import type { KvNamespaceLike } from '@durable-dav/backend-runtime/kv';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { createLogger } from '@durable-dav/backend-runtime/logger';
import { TimestampUtil, UUIDUtil } from '@durable-dav/shared/utils';
import { normalizeVolumeKey } from '@durable-dav/webdav';
import { collectSlice } from './collectSlice';
import type { LocalReplicaStub } from './collectSlice';
import { PlanExecutor, truncate } from './PlanExecutor';
import { buildRemote, siblingVolumeKey } from './buildRemote';

const logger = createLogger('Replication');

const MAX_ERROR_LENGTH = 500;

type RunResult = {
  status: 'ok' | 'partial' | 'failed';
  error: string | null;
  /**
  Paths still unvisited; non-zero means the pass is not finished.
  */
  remaining: number;
  /**
  Absence-based decisions held back because the pass was not clean.
  */
  deferredPaths: number;
};

interface ReplicationRunnerDeps {
  replicationDAO?: DavReplicationDAO;
  conflictDAO?: DavReplicationConflictDAO;
  /**
  Injected in tests; defaults to the platform `fetch`.
  */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * One volume's slice of a scheduled replication.
 *
 * This class is the *orchestration* and nothing else: when to run, which target to
 * talk to, and what to record afterwards. The three things that can lose data each
 * live in their own module and each says so at the top:
 *
 * - `collectSlice` — what could be seen, and the failure that closes the gate.
 * - `buildReplicationPlan` (`backend-services`) — what should happen, as a pure
 *   function over three arrays.
 * - `PlanExecutor` — the bytes, and the post-pass base write.
 *
 * ## The deletion gate
 *
 * `pass_started_at` on the D1 row is the gate, and it is why pass health is tracked
 * separately from per-path failures. An absence is only acted on when the pass could
 * see the whole tree; anything less and *nothing* is decided from it. A truncated
 * listing makes an absence meaningless, and acting on one is the only failure in
 * this feature that destroys data on both sides at once with no way back.
 *
 * ## Why the sweep is sliced
 *
 * `CronTasksWorker` runs every task in one Durable Object invocation with a bounded
 * CPU and wall-clock budget. A two-way sync of a large bucket fits in neither, so
 * each tick visits `REPLICATION_SLICE_PATHS` collections, records where it stopped,
 * and the next tick continues. `REPLICATION_PASS_MAX_MS` bounds how long a pass may
 * stay open: one wedged on a single erroring path would otherwise defer every
 * deletion in the tree forever with nothing to report.
 */
class ReplicationRunner {
  private readonly config: AppConfiguration;

  private readonly localStub: LocalReplicaStub;

  private readonly replicationDAO: DavReplicationDAO;

  private readonly conflictDAO: DavReplicationConflictDAO;

  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(
    private readonly env: Env,
    private readonly row: DavReplicationRow,
    private readonly localOwner: string,
    private readonly localVolume: string,
    localStub: LocalReplicaStub,
    deps: ReplicationRunnerDeps = {},
  ) {
    this.config = AppConfiguration.fromEnv(env);
    this.localStub = localStub;
    this.replicationDAO = deps.replicationDAO ?? new DavReplicationDAO(env.DB);
    this.conflictDAO = deps.conflictDAO ?? new DavReplicationConflictDAO(env.DB);
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Execute one slice and record the outcome.
   *
   * Never throws. The sweep runs many replications per tick and one unreachable
   * target must not abort the rest; the outcome goes on the row instead, where the
   * owner and the auto-disable counter can both see it.
   */
  public async runSlice(): Promise<RunResult> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const startedAt = Date.now();

    try {
      await this.reconcilePassState(now);
      const remote = await buildRemote({ env: this.env, row: this.row, config: this.config, fetchImpl: this.fetchImpl });
      // Probed once, on the first ever run, because it is the only thing that
      // distinguishes "empty" from "not a WebDAV server" — and it costs a round
      // trip that is pure overhead on every later tick.
      if (this.row.last_run_at === null) await remote.probe();

      const slice = await collectSlice({
        localStub: this.localStub,
        remote,
        replicationId: this.row.replication_id,
        maxCollections: this.config.getReplicationSlicePaths(),
        deadlineMs: startedAt + this.config.getReplicationSliceMs(),
      });

      const plan = buildReplicationPlan({
        mode: this.mode(),
        local: Array.from(slice.localByPath.values()),
        remote: Array.from(slice.remoteByPath.values()),
        base: slice.base,
        trustAbsences: slice.complete,
        hashOnAmbiguous: this.config.isReplicationHashOnAmbiguous(),
        mirrorDeletions: this.mirrorDeletions(),
        now: startedAt,
      });

      const outcome = await new PlanExecutor({
        localStub: this.localStub,
        remote,
        replicationId: this.row.replication_id,
        slice,
        deadlineMs: startedAt + this.config.getReplicationSliceMs(),
        maxBytes: this.config.getReplicationSliceBytes(),
      }).run(plan.decisions);

      await this.recordConflicts(plan.conflicts, startedAt);

      // A listing that failed closes the deletion gate but does not by itself fail
      // the pass's transfers — the two are reported separately so the owner can
      // tell "nothing to do" from "could not see the whole tree". Both count as
      // dirty, though: a pass that could not read a collection has not verified
      // anything about it, and reporting `ok` would claim it had.
      //
      // `!slice.complete` rather than `slice.errors > 0`. Those are not the same
      // condition: a volume can answer a listing *successfully* while reporting
      // that it did not cover the collection, and then `errors` is 0. Such a pass
      // had its absence-based decisions deferred, so it must also record itself
      // dirty — otherwise `recordRun` is handed `ok`, the owner sees a clean tick,
      // and `pass_started_at` is cleared as though the tree had been verified.
      const dirty = outcome.errors > 0 || slice.errors > 0 || !slice.complete;
      const status: RunResult['status'] = dirty ? (outcome.applied > 0 ? 'partial' : 'failed') : 'ok';
      await this.replicationDAO.recordRun(
        this.row.replication_id,
        status,
        dirty ? truncate(outcome.firstError ?? slice.firstError ?? 'one or more paths could not be synchronised') : null,
        now,
        this.config.getMaxReplicationFailures(),
        slice.cursor,
        slice.remaining,
      );

      await this.invalidateReadCaches();
      return {
        status,
        error: dirty ? (outcome.firstError ?? slice.firstError) : null,
        remaining: slice.remaining,
        deferredPaths: plan.deferredPaths.length,
      };
    } catch (error) {
      const message = truncateToRow(error);
      // `recordRun` with a non-`ok` status clears `pass_started_at`, closing the
      // deletion gate. That is the whole point: a pass that could not finish must
      // not be able to delete anything.
      await this.replicationDAO
        .recordRun(
          this.row.replication_id,
          'failed',
          message,
          TimestampUtil.getCurrentUnixTimestampInSeconds(),
          this.config.getMaxReplicationFailures(),
          null,
          0,
        )
        .catch((recordError: unknown) => logger.error('recording a failed replication run also failed', recordError));
      return { status: 'failed', error: message, remaining: 0, deferredPaths: 0 };
    }
  }

  /**
   * Forget the recorded base.
   *
   * Called when the replication is deleted. Without it a re-created replication
   * against the same target inherits the old base, and its first pass compares a
   * fresh tree against a record of a tree that no longer exists — reporting
   * thousands of unchanged files and propagating every deletion the old one had
   * recorded.
   */
  public async forget(): Promise<void> {
    await this.localStub.forgetReplication(this.row.replication_id);
  }

  /**
   * Open a pass, abandoning a stale one.
   *
   * `beginPass` clears any cursor left behind, which is the load-bearing part: a
   * stale cursor would make the new pass skip every collection before its position
   * and then report the sweep complete.
   */
  private async reconcilePassState(now: number): Promise<void> {
    const openedAt = this.row.pass_started_at;
    const staleSeconds = Math.floor(this.config.getReplicationPassMaxMs() / 1000);
    const stale = openedAt !== null && now - openedAt > staleSeconds;
    if (stale) logger.warn(`abandoning stale replication pass for ${this.row.replication_id}`);
    // An already-open, fresh pass is left alone: re-opening it would clear the
    // cursor the previous tick parked and make the sweep restart from the root
    // every tick, never reaching the end of a large tree.
    if (openedAt !== null && !stale) return;
    await this.replicationDAO.beginPass(this.row.replication_id, now);
    this.row.pass_started_at = now;
    if (stale) this.row.cursor_path = null;
  }

  /**
   * The stored mode, or `keep-both` when the row holds something unrecognised.
   *
   * The fallback is the *two-way* mode, so a `mode` value this build does not know
   * resolves to the most conservative behaviour that is not one-directional: a
   * stored `copy-only` or `pull-only` therefore cannot be read by an older worker
   * as "push everything" or "overwrite everything locally".
   */
  private mode(): ReplicationMode {
    const known: readonly ReplicationMode[] = ['copy-only', 'sync', 'keep-both', 'pull-only'];
    return known.includes(this.row.mode as ReplicationMode) ? (this.row.mode as ReplicationMode) : 'keep-both';
  }

  /**
   * Whether this pass may remove a local path the remote does not have.
   *
   * Read as `=== 1` rather than coerced, so a row written before 0007 (where the
   * column does not exist and `SELECT *` yields `undefined`) is the safe copy. The
   * dangerous reading is opt-in and is only reachable through a validated create or
   * patch.
   */
  private mirrorDeletions(): boolean {
    return this.row.mirror_deletions === 1;
  }

  /**
   * Purge the KV read caches for every bucket this pass wrote into.
   *
   * Not optional, and not only for the local bucket. `DavReadCache` is invalidated
   * by the front-door methods listed in `CONTENT_INVALIDATING_METHODS`, and a
   * replication write reaches none of them — so without this the browser plane
   * serves pre-sync bodies for the rest of `DAV_CACHE_TTL_SECONDS`, meaning it
   * serves content the owner already replaced.
   *
   * The *sibling* bucket matters just as much, and for a sharper reason: a
   * `dav-volume` target is written through a Durable Object RPC, so its cache is
   * not stale by accident but by construction — there is no request for the
   * front-door invalidation to observe. It surfaced as a sync that reported success
   * while `GET` kept returning the deleted file's body, which is the worst shape
   * this feature can fail in: the deletion happened, and the server said so.
   *
   * An HTTP target is deliberately *not* purged. Another deployment's cache is not
   * ours to touch, and there is no binding that would reach it anyway.
   */
  private async invalidateReadCaches(): Promise<void> {
    const binding = (this.env as { CACHE?: KvNamespaceLike }).CACHE ?? null;
    const cache = new KvCache(binding);
    if (!cache.available) return;
    await invalidateDavVolumeCaches(cache, normalizeVolumeKey(this.localOwner, this.localVolume));
    const sibling = siblingVolumeKey(this.row);
    if (sibling === null) return;
    await invalidateDavVolumeCaches(cache, sibling);
  }

  private async recordConflicts(
    conflicts: readonly { path: string; winner: 'local' | 'remote'; kind: 'conflict' | 'deletion'; conflictPath: string | null }[],
    nowMs: number,
  ): Promise<void> {
    for (const conflict of conflicts) {
      await this.conflictDAO
        .record({
          conflictId: UUIDUtil.getRandomUUID(),
          replicationId: this.row.replication_id,
          path: conflict.path,
          winner: conflict.winner,
          keptPath: conflict.conflictPath,
          kind: conflict.kind,
          now: Math.floor(nowMs / 1000),
        })
        // Best-effort: the audit row is how a destructive decision is explained
        // afterwards, but losing one row must not abandon the transfer that already
        // succeeded.
        .catch((error: unknown) => logger.warn('recording a replication conflict failed', error));
    }
  }
}

function truncateToRow(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message;
}

export { ReplicationRunner };
export type { RunResult, ReplicationRunnerDeps };

export {type LocalReplicaStub} from './collectSlice';
