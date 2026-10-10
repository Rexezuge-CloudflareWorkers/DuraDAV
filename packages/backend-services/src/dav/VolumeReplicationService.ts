import { BadRequestError, NotFoundError } from '@durable-dav/backend-errors';
import { TimestampUtil, UUIDUtil } from '@durable-dav/shared/utils';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { DavReplicationConflictDAO, DavReplicationDAO } from '@durable-dav/backend-data/dao';
import type { DavReplicationConflictRow, DavReplicationRow, ReplicationTarget } from '@durable-dav/backend-data/dao';
import { encryptReplicationSecret, resolveReplicationKey } from '@durable-dav/backend-data/crypto';
import type { ReplicationKeyProvider, SecretsStoreKeyBinding } from '@durable-dav/backend-data/crypto';
import type { ReplicationMode } from '../replication/types';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import {
  normalizeInterval,
  normalizeRemotePath,
  oneOf,
  optionalBoolean,
  optionalString,
  requireRemoteUrl,
  MAX_NAME_LENGTH,
  MAX_SECRET_LENGTH,
  REPLICATION_AUTH_KINDS,
  REPLICATION_INTERVALS,
  REPLICATION_MODES,
  REPLICATION_TARGET_KINDS,
  readMirrorDeletions,
} from './replicationInput';
import type { ReplicationAuthKind, ReplicationCreateInput, ReplicationPatchInput } from './replicationInput';

interface VolumeReplicationServiceEnv {
  DB: D1Queryable;
  /**
   * `secrets_store_secrets` binding — the preferred source for the key.
   *
   * Read through `resolveReplicationKey` rather than as a string, so the key
   * never sits in the Worker environment and is fetched at most once per
   * instance. See `backend-data/src/crypto/replicationKey.ts`.
   */
  REPLICATION_ENCRYPTION_KEY_SECRET?: SecretsStoreKeyBinding;
  /**
  Plain-var fallback for local dev and tests. Refused in production.
  */
  REPLICATION_ENCRYPTION_KEY?: string;
}

interface VolumeReplicationServiceDeps {
  replicationDAO?: () => Promise<DavReplicationDAO>;
  conflictDAO?: () => Promise<DavReplicationConflictDAO>;
  config?: AppConfiguration;
}

/**
 * Owner-facing replication configuration and validation.
 *
 * Owner-only by construction: every method takes a `volumeId` that the caller's
 * route already resolved through `VolumeScopedRoute`'s ownership guard. There is
 * deliberately no credential-authenticated entry point — see `ReplicationRoutes`
 * for why a bucket credential must never be able to name a target.
 */
class VolumeReplicationService {
  private readonly deps: Required<VolumeReplicationServiceDeps>;

  /**
   * One memoized key source per service instance.
   *
   * Resolved in the constructor rather than per `seal()` call so a create/patch
   * that seals once does not re-fetch, and so the fetch failure is reported the
   * same way every time.
   */
  private readonly replicationKey: ReplicationKeyProvider;

  constructor(
    private readonly env: VolumeReplicationServiceEnv,
    deps: VolumeReplicationServiceDeps = {},
  ) {
    this.deps = {
      replicationDAO: deps.replicationDAO ?? (() => Promise.resolve(new DavReplicationDAO(env.DB))),
      conflictDAO: deps.conflictDAO ?? (() => Promise.resolve(new DavReplicationConflictDAO(env.DB))),
      config: deps.config ?? AppConfiguration.fromEnv(env),
    };
    this.replicationKey = resolveReplicationKey({
      binding: env.REPLICATION_ENCRYPTION_KEY_SECRET,
      rawVar: env.REPLICATION_ENCRYPTION_KEY,
      // The service already holds a resolved `AppConfiguration`; asking it
      // rather than reading the env keeps the production rule in one place.
      isProduction: this.deps.config.getEnvironment() === 'production',
    });
  }

  /**
  The intervals the UI offers. Mirrored client-side; see `replicationService.ts`.
  */
  public static allowedIntervals(): readonly number[] {
    return REPLICATION_INTERVALS;
  }

  public async listReplications(volumeId: string): Promise<DavReplicationRow[]> {
    const dao = await this.deps.replicationDAO();
    return dao.listByVolume(volumeId);
  }

  public async getReplication(volumeId: string, replicationId: string): Promise<DavReplicationRow> {
    return this.requireReplication(volumeId, replicationId);
  }

  /**
   * A replication that belongs to *this* volume.
   *
   * Scoped on `volume_id` rather than looked up by id alone. Without the scope a
   * caller holding any replication id could read another bucket's target URL and
   * its `last_error` — which, on a deployment where target URLs are internal
   * hostnames, is enough to map private infrastructure.
   */
  public async requireReplication(volumeId: string, replicationId: string): Promise<DavReplicationRow> {
    const dao = await this.deps.replicationDAO();
    const row = await dao.getById(replicationId);
    if (!row || row.volume_id !== volumeId) throw new NotFoundError('Replication not found');
    return row;
  }

  public async createReplication(
    volumeId: string,
    localPath: string,
    input: ReplicationCreateInput,
    creatorEmail: string,
  ): Promise<DavReplicationRow> {
    const dao = await this.deps.replicationDAO();
    const targetKind = oneOf(input.targetKind, REPLICATION_TARGET_KINDS, 'targetKind');
    const mode = oneOf(input.mode, REPLICATION_MODES, 'mode', 'keep-both');
    // Resolved against the mode resolved above, so a create body carrying both can
    // never be validated against a mode it is not going to be stored with.
    const mirrorDeletions = readMirrorDeletions(input.mirrorDeletions, mode);
    const authKind = oneOf(input.authKind, REPLICATION_AUTH_KINDS, 'authKind', 'none');
    const intervalMinutes = normalizeInterval(input.intervalMinutes);
    const enabled = optionalBoolean(input.enabled, 'enabled', true);
    const remotePath = normalizeRemotePath(input.remotePath);

    const remoteUrl = targetKind === 'dav' ? requireRemoteUrl(input.remoteUrl, this.allowedHosts()) : '';
    const remoteOwner = targetKind === 'dav-volume' ? optionalString(input.remoteOwner, 'remoteOwner', MAX_NAME_LENGTH) : '';
    const remoteVolume = targetKind === 'dav-volume' ? optionalString(input.remoteVolume, 'remoteVolume', MAX_NAME_LENGTH) : '';

    if (targetKind === 'dav-volume') {
      if (remoteOwner === '' || remoteVolume === '') {
        throw new BadRequestError('remoteOwner and remoteVolume are required when targetKind is dav-volume');
      }
      // Compared on the volume *path*, not the id: the Durable Object is keyed
      // by path, so a bucket replicating to itself would deadlock — the runner
      // would call the same object it is already executing inside.
      if (`${remoteOwner}/${remoteVolume}`.toLowerCase() === localPath.toLowerCase()) {
        throw new BadRequestError('A volume cannot replicate to itself');
      }
    }

    const secret = authKind === 'none' ? '' : optionalString(input.secret, 'secret', MAX_SECRET_LENGTH);
    if (authKind !== 'none' && secret === '') {
      throw new BadRequestError(`secret is required when authKind is ${authKind}`);
    }
    if (authKind === 'basic' && optionalString(input.username, 'username', MAX_NAME_LENGTH) === '') {
      throw new BadRequestError('username is required when authKind is basic');
    }

    const used = await dao.countByVolume(volumeId);
    if (used >= this.deps.config.getMaxReplicationsPerVolume()) {
      throw new BadRequestError(`A volume may have at most ${this.deps.config.getMaxReplicationsPerVolume()} replications`);
    }

    const target: ReplicationTarget = { targetKind, remoteUrl, remoteOwner, remoteVolume, remotePath };
    if (await dao.getByVolumeAndTarget(volumeId, target)) {
      // The unique index would turn this into a constraint 500. Reporting the
      // conflict it actually is keeps the API's error contract intact.
      throw new BadRequestError('This target is already configured for this volume');
    }

    const envelope = secret === '' ? { ciphertext: null, iv: null } : await this.seal(secret);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const replicationId = UUIDUtil.getRandomUUID();
    await dao.create({
      replicationId,
      volumeId,
      target,
      authKind,
      encryptedSecret: envelope.ciphertext,
      secretIv: envelope.iv,
      mode,
      mirrorDeletions,
      intervalMinutes,
      enabled,
      now,
      createdBy: creatorEmail,
    });
    const created = await dao.getById(replicationId);
    if (!created) throw new NotFoundError('Replication not found after create');
    return created;
  }

  /**
   * Update the mutable settings.
   *
   * The target is absent on purpose. Re-pointing a replication mid-flight leaves
   * the recorded base describing a tree that no longer exists, so a target change
   * is delete-then-create — which also drops the base, correctly, rather than
   * comparing against a stranger's tree.
   */
  public async updateReplication(volumeId: string, replicationId: string, input: ReplicationPatchInput): Promise<DavReplicationRow> {
    const dao = await this.deps.replicationDAO();
    const existing = await this.requireReplication(volumeId, replicationId);
    const patch: { mode?: ReplicationMode; mirrorDeletions?: boolean; intervalMinutes?: number; enabled?: boolean; now: number } = {
      now: TimestampUtil.getCurrentUnixTimestampInSeconds(),
    };
    if (input.mode !== undefined) patch.mode = oneOf(input.mode, REPLICATION_MODES, 'mode');
    // Resolved against the mode that will be in force *after* this patch, so the two
    // fields can be changed together without the caller having to order them.
    if (input.mirrorDeletions !== undefined) {
      patch.mirrorDeletions = readMirrorDeletions(input.mirrorDeletions, patch.mode ?? existing.mode);
    } else if (patch.mode !== undefined && existing.mirror_deletions === 1) {
      // Moving off `pull-only` with the mirror flag still set would leave a row whose
      // flag nothing reads, and a later switch back to `pull-only` would silently
      // re-arm a destructive behaviour the owner had long since stopped using.
      // Cleared rather than left dangling.
      patch.mirrorDeletions = readMirrorDeletions(false, patch.mode);
    }
    if (input.intervalMinutes !== undefined) patch.intervalMinutes = normalizeInterval(input.intervalMinutes);
    if (input.enabled !== undefined) patch.enabled = optionalBoolean(input.enabled, 'enabled', existing.enabled === 1);
    await dao.update(replicationId, patch);
    const updated = await dao.getById(replicationId);
    if (!updated) throw new NotFoundError('Replication not found after update');
    return updated;
  }

  /**
   * Replace the stored credential.
   *
   * Allowed without touching the base, because the target is the same server —
   * only the way this Worker authenticates to it changed.
   */
  public async rotateSecret(
    volumeId: string,
    replicationId: string,
    input: { authKind?: unknown; username?: unknown; secret?: unknown },
  ): Promise<DavReplicationRow> {
    const dao = await this.deps.replicationDAO();
    const existing = await this.requireReplication(volumeId, replicationId);
    const authKind = oneOf(input.authKind, REPLICATION_AUTH_KINDS, 'authKind', existing.auth_kind === 'none' ? undefined : (existing.auth_kind as ReplicationAuthKind));
    const secret = optionalString(input.secret, 'secret', MAX_SECRET_LENGTH);
    if (authKind !== 'none' && secret === '') throw new BadRequestError(`secret is required when authKind is ${authKind}`);
    const envelope = secret === '' ? { ciphertext: null, iv: null } : await this.seal(secret);
    await dao.setSecret(replicationId, envelope.ciphertext, envelope.iv, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const updated = await dao.getById(replicationId);
    if (!updated) throw new NotFoundError('Replication not found after credential update');
    return updated;
  }

  public async deleteReplication(volumeId: string, replicationId: string): Promise<void> {
    await this.requireReplication(volumeId, replicationId);
    const dao = await this.deps.replicationDAO();
    await dao.deleteById(replicationId);
  }

  public async listConflicts(volumeId: string, replicationId: string, includeResolved: boolean): Promise<DavReplicationConflictRow[]> {
    await this.requireReplication(volumeId, replicationId);
    const dao = await this.deps.conflictDAO();
    return dao.listByReplication(replicationId, includeResolved);
  }

  public async resolveConflict(volumeId: string, replicationId: string, conflictId: string): Promise<boolean> {
    await this.requireReplication(volumeId, replicationId);
    const dao = await this.deps.conflictDAO();
    return dao.markResolved(replicationId, conflictId, TimestampUtil.getCurrentUnixTimestampInSeconds());
  }

  public async countUnresolvedConflicts(volumeId: string, replicationId: string): Promise<number> {
    await this.requireReplication(volumeId, replicationId);
    const dao = await this.deps.conflictDAO();
    return dao.countUnresolved(replicationId);
  }

  /**
   * The egress allowlist, from configuration only.
   *
   * Never from the request body — an allowlist a caller can extend is not an
   * allowlist.
   */
  public allowedHosts(): string[] {
    return [...this.deps.config.getReplicationAllowedHostList()];
  }

  private async seal(secret: string): Promise<{ ciphertext: string; iv: string }> {
    const envelope = await encryptReplicationSecret(secret, await this.replicationKey());
    return { ciphertext: envelope.ciphertext, iv: envelope.iv };
  }
}

export { VolumeReplicationService };

export { type ReplicationMode } from '../replication/types';

export {type ReplicationCreateInput, type ReplicationPatchInput, type ReplicationAuthKind} from './replicationInput';
