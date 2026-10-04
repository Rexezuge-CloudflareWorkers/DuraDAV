import { TimestampUtil } from '@durable-dav/shared/utils';
import { Tokens, createRequestScope } from '@durable-dav/backend-services/composition';
import { createLogger } from '@durable-dav/backend-runtime/logger';
import { normalizeVolumeKey } from '@durable-dav/webdav';
import type { DavReplicationConflictDAO, DavReplicationDAO, DavVolumeDAO } from '@durable-dav/backend-data/dao';
import { ReplicationRunner } from '../replication/ReplicationRunner';
import type { LocalReplicaStub, RunResult } from '../replication/ReplicationRunner';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

/**
 * Periodic sweep over every enabled replication whose interval has elapsed.
 *
 * Phase 2, deliberately. Phase 1 is the cheap hygiene pass, and a replication
 * that deletes on both sides has no business running before the pass whose job is
 * to remove expired credentials has finished — if this tick is going to be slow,
 * it should be slow *after* the housekeeping, not instead of it.
 *
 * The sweep is bounded three ways, and all three matter:
 *
 * - `REPLICATION_SWEEP_LIMIT` replications per tick, so one account with many
 *   buckets cannot monopolise a deployment's cron budget.
 * - Per-replication try/catch, so one unreachable target cannot starve the rest.
 *   The same rule the phase runner applies per task, one level down.
 * - A slice budget inside each runner, because a full two-way sync does not fit in
 *   one Durable Object invocation and pretending otherwise produces a timeout with
 *   no record of what was transferred.
 */
class ReplicationSyncTask extends BaseScheduledTask {
  public readonly name = 'ReplicationSyncTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    // One scope for the whole sweep. A scheduled task has no Hono context, so this
    // is the composition root rather than `BaseRoute.getScope` — and reusing it
    // means the DAOs are constructed once per tick instead of once per row.
    const scope = createRequestScope(env);
    const config = scope.get(Tokens.AppConfig);
    const replicationDAO = await scope.get(Tokens.DavReplicationDAO)();
    const volumeDAO = await scope.get(Tokens.DavVolumeDAO)();
    const conflictDAO = await scope.get(Tokens.DavReplicationConflictDAO)();

    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const due = await replicationDAO.listDue(now, config.getReplicationSweepLimit());
    if (due.length === 0) return;

    logger.info(`Running ${due.length} due replication(s)`);
    let ok = 0;
    let partial = 0;
    let failed = 0;

    for (const row of due) {
      // Every failure is contained here. `runSlice` already swallows and records,
      // but the volume lookup below throws on its own, and one bad row must not
      // take the rest of the sweep with it.
      try {
        const result = await this.runOne(env, row.replication_id, row.volume_id, volumeDAO, replicationDAO, conflictDAO);
        if (result.status === 'ok') ok += 1;
        else if (result.status === 'partial') partial += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        logger.error(`Replication ${row.replication_id} could not be run`, error);
      }
    }
    logger.info(`Replication sweep finished: ${ok} ok, ${partial} partial, ${failed} failed`);
  }

  /**
   * Resolve the volume's Durable Object and run one slice against it.
   *
   * The volume row is read per replication rather than denormalised onto the
   * replication row, because `dav_volumes.owner` is the canonical handle and it
   * changes: a username rename rewrites it while the replication keeps its
   * `volume_id`. A cached copy of the old path would resolve to a Durable Object
   * that no longer receives the owner's writes — a silent fork, replicating a
   * bucket nobody is using.
   */
  private async runOne(
    env: Env,
    replicationId: string,
    volumeId: string,
    volumeDAO: DavVolumeDAO,
    replicationDAO: DavReplicationDAO,
    conflictDAO: DavReplicationConflictDAO,
  ): Promise<RunResult> {
    const volume = await volumeDAO.getById(volumeId);
    if (!volume) {
      // `dav_replications` cascades on `volume_id`, so this should be
      // unreachable. Deleting the orphan anyway keeps the sweep from retrying it
      // on every tick forever if the cascade is ever lost.
      logger.warn(`replication ${replicationId} references a missing volume; removing it`);
      await replicationDAO.deleteById(replicationId);
      return { status: 'ok', error: null, remaining: 0, deferredPaths: 0 };
    }
    const replication = await replicationDAO.getById(replicationId);
    if (!replication) return { status: 'ok', error: null, remaining: 0, deferredPaths: 0 };

    const namespace = (env as { DAV_VOLUME?: { getByName: (name: string) => unknown } }).DAV_VOLUME;
    if (!namespace) {
      logger.error('DAV_VOLUME binding is not configured; skipping replication sweep');
      return { status: 'failed', error: 'DAV_VOLUME binding is not configured', remaining: 0, deferredPaths: 0 };
    }
    // `normalizeVolumeKey` is what makes the sweep and the front door agree on the
    // isolate: a raw-case `getByName` would fork a second object.
    const stub = namespace.getByName(normalizeVolumeKey(volume.owner, volume.name)) as LocalReplicaStub;
    const runner = new ReplicationRunner(env, replication, volume.owner, volume.name, stub, { replicationDAO, conflictDAO });
    return runner.runSlice();
  }
}

export { ReplicationSyncTask };
