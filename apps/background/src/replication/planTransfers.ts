import { createLogger } from '@durable-dav/backend-runtime/logger';
import type { LocalReplicaStub } from './collectSlice';
import type { RemoteVolume } from '@durable-dav/backend-services/replication';
import type { Slice } from './collectSlice';

const logger = createLogger('Replication');

/**
 * The two ways a plan moves bytes, and nothing else.
 *
 * Split out of `PlanExecutor` for one reason: `pull-and-preserve` is a whole
 * transfer strategy rather than one more branch of a switch, and folding it in
 * would have put a 40-line method and its reasoning inside the file whose job is
 * to orchestrate a batch. The rule it exists to state is simple enough that it
 * should be readable on its own:
 *
 * > `pull-only` never writes to the remote.
 *
 * Every other mode may write in both directions. This one writes down only, and the
 * local version it would have overwritten is preserved beside the path rather than
 * discarded. That is what makes "the remote is the authority" a statement about
 * *precedence* rather than about destroying the owner's work.
 */

type TransferContext = {
  localStub: LocalReplicaStub;
  remote: RemoteVolume;
  replicationId: string;
  slice: Slice;
  /**
   * Errors found applying a batch of local operations, or `null` when they all
   * landed. Thrown so the caller records one failed path rather than a silently
   * half-applied transfer.
   */
  applied(result: { failed: number; error: string | null }, what: string): void;
};

/**
 * `keep-both`: preserve the losing version on both sides.
 *
 * The winner stays at `path`; each side's bytes are copied into the *other* side's
 * conflict slot, so both keep a copy and a person can recover the edit they did not
 * expect to lose.
 */
async function keepBoth(context: TransferContext, path: string, conflictPath: string): Promise<void> {
  if (await preserveConflictingCollection(context, path, conflictPath)) return;

  const { localStub, remote, slice } = context;
  const localEntry = slice.localByPath.get(path);
  const remoteEntry = slice.remoteByPath.get(path);
  const remoteStream = remoteEntry === undefined || remoteEntry.isCollection ? null : await remote.readFile(path);
  if (remoteStream !== null) {
    context.applied(
      await localStub.applyReplicaOperations(context.replicationId, [
        { op: 'write', path: conflictPath, contentType: localEntry?.contentType ?? null, data: remoteStream },
      ]),
      'writing the conflict copy locally',
    );
  }
  if (localEntry === undefined || localEntry.isCollection) return;
  const localStream = await localStub.readReplicaStream(path);
  if (localStream !== null) await remote.writeFile(conflictPath, localStream, { contentType: localEntry.contentType, ifMatch: null });
}

/**
 * `pull-and-preserve`: the remote's version lands at `path`, the local version is
 * kept at `conflictPath`, and the remote is not written at all.
 *
 * Ordering is the safety argument. The local bytes are copied to the conflict path
 * **before** the remote's version is written over `path`, so a failure between the
 * two leaves the original intact rather than truncating it in place — the same
 * ordering `dofs.writeFile` uses for the quota check, and for the same reason.
 *
 * A collection is not a byte stream, so it takes the structural path instead: the
 * remote's `makeCollection` and the local `mkdir` are both idempotent, and there is
 * nothing at `path` whose bytes need preserving beyond the collection itself.
 */
async function pullAndPreserve(context: TransferContext, path: string, conflictPath: string, contentType: string | null): Promise<void> {
  const { localStub, remote, replicationId, slice } = context;
  const localEntry = slice.localByPath.get(path);
  const remoteEntry = slice.remoteByPath.get(path) ?? (await remote.stat(path));
  const remoteIsCollection = remoteEntry?.isCollection === true;
  const localIsCollection = localEntry?.isCollection === true;

  if (localIsCollection || localEntry === undefined) {
    // Nothing at `path` whose bytes would be lost, so this is an ordinary create.
    if (remoteIsCollection) {
      context.applied(await localStub.applyReplicaOperations(replicationId, [{ op: 'mkdir', path }]), 'local mkdir');
      return;
    }
    await remoteToLocal(context, path, contentType);
    return;
  }

  if (remoteIsCollection) {
    // Collection replacing file: there is no remote bytes to write, and the local
    // file is preserved whole rather than being lost to a directory that replaced it.
    context.applied(await localStub.applyReplicaOperations(replicationId, [{ op: 'mkdir', path: conflictPath }]), 'writing the conflict collection');
    context.applied(await localStub.applyReplicaOperations(replicationId, [{ op: 'unlink', path, recursive: false }]), 'replacing a file with a collection');
    context.applied(await localStub.applyReplicaOperations(replicationId, [{ op: 'mkdir', path }]), 'local mkdir');
    return;
  }

  const localStream = await localStub.readReplicaStream(path);
  if (localStream === null) {
    // The local side could not be read, so there is nothing to preserve and nothing
    // to compare against. Pulling would overwrite bytes nobody captured.
    logger.warn(`pull-only: ${path} was not readable locally; leaving it untouched rather than overwriting it`);
    return;
  }
  context.applied(
    await localStub.applyReplicaOperations(replicationId, [{ op: 'write', path: conflictPath, contentType: localEntry.contentType, data: localStream }]),
    'preserving the local version',
  );
  await remoteToLocal(context, path, contentType);
}

/**
 * Write the remote's version down to `path`.
 */
async function remoteToLocal(context: TransferContext, path: string, contentType: string | null): Promise<void> {
  const { localStub, remote, replicationId } = context;
  const stream = await remote.readFile(path);
  if (stream === null) return;
  context.applied(
    await localStub.applyReplicaOperations(replicationId, [{ op: 'write', path, contentType, data: stream }]),
    'writing the remote version locally',
  );
}

/**
 * The collection-vs-something cases of `keepBoth`.
 *
 * Returns whether it handled the path, so the caller can open with the exception
 * rather than burying it above two `const` declarations.
 */
async function preserveConflictingCollection(context: TransferContext, path: string, conflictPath: string): Promise<boolean> {
  const { localStub, remote, replicationId, slice } = context;
  const localIsCollection = slice.localByPath.get(path)?.isCollection === true;
  if (localIsCollection) {
    await remote.makeCollection(conflictPath);
    return true;
  }
  const remoteIsCollection = slice.remoteByPath.get(path)?.isCollection === true;
  // Nothing to preserve when the local side holds the bytes — that is the
  // file-vs-file case, handled by the caller.
  if (!remoteIsCollection || slice.localByPath.has(path)) return false;
  context.applied(await localStub.applyReplicaOperations(replicationId, [{ op: 'mkdir', path: conflictPath }]), 'writing the conflict collection');
  return true;
}

export { keepBoth, pullAndPreserve };
export type { TransferContext };