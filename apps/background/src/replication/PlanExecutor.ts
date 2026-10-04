import { createLogger } from '@durable-dav/backend-runtime/logger';

import type { ReplicationDecision, RemoteVolume } from '@durable-dav/backend-services/replication';
import { CryptoUtil } from '@durable-dav/shared/utils';
import type { ReplicaStateRow } from '@durable-dav/dav-store';
import type { LocalReplicaStub, Slice } from './collectSlice';
import { parentOf } from './collectSlice';

const logger = createLogger('Replication');

type ApplyOptions = {
  localStub: LocalReplicaStub;
  remote: RemoteVolume;
  replicationId: string;
  slice: Slice;
  /**
  Wall-clock budget; checked between files, not up front.
  */
  deadlineMs: number;
  /**
  Byte budget; checked between files.
  */
  maxBytes: number;
};

type ApplyOutcome = {
  applied: number;
  errors: number;
  firstError: string | null;
  /**
  Bytes actually moved, so the caller can decide whether to continue.
  */
  movedBytes: number;
};

/**
 * Carry out a plan, then write the base from a fresh read of both sides.
 *
 * Split out of `ReplicationRunner` because it is the half that touches bytes and
 * the half that can destroy data; the runner's own job is deciding *when* this
 * runs and recording the outcome.
 */
class PlanExecutor {
  private movedBytes = 0;

  private applied = 0;

  private errors = 0;

  private firstError: string | null = null;

  constructor(private readonly options: ApplyOptions) {}

  public async run(decisions: readonly ReplicationDecision[]): Promise<ApplyOutcome> {
    for (const decision of decisions) {
      if (Date.now() >= this.options.deadlineMs || this.movedBytes >= this.options.maxBytes) break;
      try {
        const size = await this.applyDecision(decision);
        if (size !== null) this.movedBytes += size;
        this.applied += 1;
      } catch (error) {
        this.errors += 1;
        if (this.firstError === null) {
          this.firstError = `${decision.kind} ${decision.path}: ${error instanceof Error ? error.message : String(error)}`;
        }
        // One unmappable path — a name the remote invented, a file that vanished
        // mid-pass — must not abandon the rest of the slice.
      }
    }

    const recording = await this.recordBase(this.touched);
    this.errors += recording.errors;
    if (this.firstError === null) this.firstError = recording.firstError;
    return { applied: this.applied, errors: this.errors, firstError: this.firstError, movedBytes: this.movedBytes };
  }

  /**
  Every path the plan acted on, for the post-pass re-read.
  */
  private readonly touched = new Set<string>();

  private async applyDecision(decision: ReplicationDecision): Promise<number | null> {
    const { localStub, remote, replicationId } = this.options;
    this.touched.add(decision.path);
    switch (decision.kind) {
      case 'push': {
        return this.push(decision.path);
      }
      case 'pull': {
        return this.pull(decision.path, decision.contentType);
      }
      case 'delete-remote': {
        await remote.remove(decision.path, { ifMatch: null, recursive: true });
        return 0;
      }
      case 'delete-local': {
        const result = await localStub.applyReplicaOperations(replicationId, [{ op: 'unlink', path: decision.path, recursive: true }]);
        if (result.failed > 0) throw new Error(result.error ?? 'local delete failed');
        return 0;
      }
      case 'keep-both': {
        await this.keepBoth(decision.path, decision.conflictPath);
        return 0;
      }
      case 'compare-content': {
        return this.compareContent(decision.path, decision.winner);
      }
      case 'agree':
      case 'forget': {
        // No transfer. The bookkeeping still happens, in `recordBase`: `agree`
        // refreshes `synced_at` and `forget` drops the row.
        return 0;
      }
      default: {
        return null;
      }
    }
  }

  /**
  Local -> remote.
  */
  private async push(path: string): Promise<number | null> {
    const { localStub, remote, slice } = this.options;
    const localEntry = slice.localByPath.get(path);
    if (localEntry === undefined) return null;
    if (localEntry.isCollection) {
      await remote.makeCollection(path);
      return 0;
    }
    const stream = await localStub.readReplicaStream(path);
    if (stream === null) return null;
    await remote.writeFile(path, stream, { contentType: localEntry.contentType, ifMatch: null });
    return localEntry.size ?? 0;
  }

  /**
  Remote -> local.
  */
  private async pull(path: string, contentType: string | null): Promise<number | null> {
    const { localStub, remote, replicationId, slice } = this.options;
    // `ifMatch` carries the ETag we last saw, so a concurrent human write is
    // rejected rather than silently overwritten. Absent on a first write, which is
    // the only time omitting it is correct.
    const remoteEntry = slice.remoteByPath.get(path) ?? (await remote.stat(path));
    if (remoteEntry === null) return null;
    if (remoteEntry.isCollection) {
      const result = await localStub.applyReplicaOperations(replicationId, [{ op: 'mkdir', path }]);
      if (result.failed > 0) throw new Error(result.error ?? 'local mkdir failed');
      return 0;
    }
    const stream = await remote.readFile(path);
    if (stream === null) return null;
    const result = await localStub.applyReplicaOperations(replicationId, [{ op: 'write', path, contentType, data: stream }]);
    if (result.failed > 0) throw new Error(result.error ?? 'local write failed');
    return remoteEntry.size ?? 0;
  }

  /**
   * Preserve the losing version instead of overwriting the winner.
   *
   * The winner stays at `path`; the loser is written beside it at `conflictPath` on
   * the side it came from. Both sides therefore keep a copy, which is the only
   * outcome from which a person can recover the edit they did not expect to lose.
   */
  private async keepBoth(path: string, conflictPath: string): Promise<void> {
    if (await this.preserveConflictingCollection(path, conflictPath)) return;

    // Both sides hold bytes. Each is copied into the *other* side's conflict slot.
    const { localStub, remote, slice } = this.options;
    const localEntry = slice.localByPath.get(path);
    const remoteEntry = slice.remoteByPath.get(path);
    const remoteStream = remoteEntry === undefined || remoteEntry.isCollection ? null : await remote.readFile(path);
    if (remoteStream !== null) {
      const written = await localStub.applyReplicaOperations(this.options.replicationId, [
        { op: 'write', path: conflictPath, contentType: localEntry?.contentType ?? null, data: remoteStream },
      ]);
      if (written.failed > 0) throw new Error(written.error ?? 'writing the conflict copy locally failed');
    }
    if (localEntry === undefined || localEntry.isCollection) return;
    const localStream = await localStub.readReplicaStream(path);
    if (localStream !== null) await remote.writeFile(conflictPath, localStream, { contentType: localEntry.contentType, ifMatch: null });
  }

  /**
   * The collection-vs-something case of `keepBoth`.
   *
   * Returns whether it handled the path. Split out so `keepBoth` opens with its
   * exception rather than burying it above two `const` declarations.
   */
  private async preserveConflictingCollection(path: string, conflictPath: string): Promise<boolean> {
    const { localStub, remote, replicationId, slice } = this.options;
    const localIsCollection = slice.localByPath.get(path)?.isCollection === true;
    if (localIsCollection) {
      await remote.makeCollection(conflictPath);
      return true;
    }
    const remoteIsCollection = slice.remoteByPath.get(path)?.isCollection === true;
    // Nothing to preserve when the local side holds the bytes — that is the
    // file-vs-file case, handled by the caller.
    if (!remoteIsCollection || slice.localByPath.has(path)) return false;
    const written = await localStub.applyReplicaOperations(replicationId, [{ op: 'mkdir', path: conflictPath }]);
    if (written.failed > 0) throw new Error(written.error ?? 'writing the conflict collection failed');
    return true;
  }

  /**
   * Settle an ambiguous pair by hashing both sides.
   *
   * Opt-in, because it costs two full reads of every file whose validators
   * disagree but whose sizes match. Equal hashes mean the two sides are recorded
   * as agreeing; different hashes mean the winner takes the path.
   */
  private async compareContent(path: string, winner: 'local' | 'remote'): Promise<number | null> {
    const { localStub, remote } = this.options;
    const [localBytes, remoteStream] = await Promise.all([localStub.readReplicaBytes(path), remote.readFile(path)]);
    if (localBytes === null || remoteStream === null) return null;
    const remoteBytes = new Uint8Array(await new Response(remoteStream).arrayBuffer());
    const [localHash, remoteHash] = await Promise.all([
      CryptoUtil.sha256Hex(bytesToBinary(localBytes)),
      CryptoUtil.sha256Hex(bytesToBinary(remoteBytes)),
    ]);
    if (localHash === remoteHash) {
      logger.info(`replication content hash matched for ${path}`);
      return 0;
    }
    logger.info(`replication content hash differs for ${path}; applying the ${winner} side`);
    return winner === 'local' ? this.push(path) : this.pull(path, this.options.slice.remoteByPath.get(path)?.contentType ?? null);
  }

  /**
   * Write the base for every path this slice touched, from a fresh read of both
   * sides.
   *
   * Three outcomes, and the third is the one that matters:
   *
   * - present on both sides -> record the agreement.
   * - absent from both -> forget the path entirely.
   * - present on exactly one -> **record nothing**. A half-applied transfer must
   *   not be remembered as agreement, or the next pass would see "unchanged" and
   *   never finish the job.
   */
  private async recordBase(touched: ReadonlySet<string>): Promise<{ errors: number; firstError: string | null }> {
    const { localStub, remote, replicationId } = this.options;
    const records: ReplicaStateRow[] = [];
    const forget: string[] = [];

    for (const path of touched) {
      // Both reads degrade to `null` on failure, which lands in the "present on
      // exactly one side" case below — so an unreadable path records no base at
      // all rather than recording a wrong one.
      const localEntry = await localStub
        .listReplicaChildren(parentOf(path))
        .then((entries) => entries.find((entry) => entry.path === path) ?? null)
        .catch(() => null);
      const remoteEntry = await remote.stat(path).catch(() => null);
      if (localEntry === null && remoteEntry === null) {
        forget.push(path);
        continue;
      }
      if (localEntry === null || remoteEntry === null) continue;
      records.push({
        replicationId,
        path,
        isCollection: localEntry.isCollection,
        localEtag: localEntry.etag,
        localMtime: localEntry.mtime,
        localSize: localEntry.size,
        remoteEtag: remoteEntry.etag,
        remoteMtime: remoteEntry.mtime,
        remoteSize: remoteEntry.size,
        contentType: localEntry.contentType ?? remoteEntry.contentType,
        syncedAt: Date.now(),
      });
    }

    const operations: unknown[] = [...records.map((state) => ({ op: 'record', state })), ...forget.map((path) => ({ op: 'forget', path }))];
    if (operations.length === 0) return { errors: 0, firstError: null };
    const result = await localStub.applyReplicaOperations(replicationId, operations);
    return result.failed === 0 ? { errors: 0, firstError: null } : { errors: result.failed, firstError: truncate(result.error ?? 'recording the sync base failed') };
  }
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return binary;
}

function truncate(message: string): string {
  return message.length > 300 ? message.slice(0, 300) : message;
}

export { PlanExecutor, truncate };
export type { ApplyOptions, ApplyOutcome };

export {RemoteUnavailableError} from '@durable-dav/backend-services/replication';
