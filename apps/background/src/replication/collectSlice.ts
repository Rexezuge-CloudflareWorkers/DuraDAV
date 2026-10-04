import { createLogger } from '@durable-dav/backend-runtime/logger';
import type { RemoteEntry, RemoteListing, RemoteVolume } from '@durable-dav/backend-services/replication';
import type { PlanBase } from '@durable-dav/backend-services/replication';
import type { ReplicaStateRow } from '@durable-dav/dav-store';

const logger = createLogger('Replication');

/**
The slice's view of the volume Durable Object holding the local side.
*/
export interface LocalReplicaStub {
  listReplicaChildren(path: string): Promise<RemoteEntry[]>;
  readReplicaStream(path: string): Promise<ReadableStream<Uint8Array> | null>;
  readReplicaBytes(path: string): Promise<Uint8Array | null>;
  applyReplicaOperations(replicationId: string, operations: unknown[]): Promise<{ applied: number; failed: number; error: string | null }>;
  loadReplicaStateRows(replicationId: string): Promise<ReplicaStateRow[]>;
  forgetReplication(replicationId: string): Promise<void>;
}

export type Slice = {
  localByPath: Map<string, RemoteEntry>;
  remoteByPath: Map<string, RemoteEntry>;
  base: PlanBase[];
  /**
  Every collection listed completely on both sides, with no errors.
  */
  complete: boolean;
  /**
  Collections that could not be listed. Any value closes the deletion gate.
  */
  errors: number;
  /**
  First listing error, for the run record.
  */
  firstError: string | null;
  remaining: number;
  cursor: string | null;
};

type CollectSliceOptions = {
  localStub: LocalReplicaStub;
  remote: RemoteVolume;
  replicationId: string;
  maxCollections: number;
  deadlineMs: number;
};

/**
 * Walk outward from the root, visiting at most `maxCollections` collections.
 *
 * Breadth-first, so a slice that runs out of budget has still covered the shallow
 * tree — the part a human is most likely to have just changed — and so a parent is
 * always visited before its children.
 *
 * The queue is de-duplicated across both trees deliberately. Local and remote both
 * offer the same directory names, and without a shared `queued` set it would be
 * listed twice, doubling every request for a two-way target.
 *
 * ## What a failure means here
 *
 * A collection that could not be listed counts as an error and clears
 * `complete`, which is what closes the deletion gate for the pass. It is
 * emphatically *not* treated as an empty collection: "this directory has no
 * children" and "we could not read this directory" have opposite consequences,
 * and only one of them is a reason to delete things.
 */
async function collectSlice(options: CollectSliceOptions): Promise<Slice> {
  const { localStub, remote, replicationId, maxCollections, deadlineMs } = options;
  const localByPath = new Map<string, RemoteEntry>();
  const remoteByPath = new Map<string, RemoteEntry>();
  const visited = new Set<string>();
  const queued = new Set<string>(['']);
  const queue: string[] = [''];
  let complete = true;
  let errors = 0;
  let firstError: string | null = null;
  let cursor: string | null = null;

  while (queue.length > 0 && visited.size < maxCollections && Date.now() < deadlineMs) {
    const current = queue.shift();
    if (current === undefined) break;
    visited.add(current);
    queued.delete(current);
    cursor = current;

    const localChildren = await localStub.listReplicaChildren(current).catch((error: unknown) => {
      errors += 1;
      if (firstError === null) firstError = `listing ${current} locally: ${describe(error)}`;
      logger.warn(`listing ${current} locally failed`, error);
      return [] as RemoteEntry[];
    });
    for (const entry of localChildren) {
      localByPath.set(entry.path, entry);
      if (!entry.isCollection || queued.has(entry.path) || visited.has(entry.path)) {
        continue;
      }

      queued.add(entry.path);
      queue.push(entry.path);
    }

    let listing: RemoteListing;
    try {
      listing = await remote.list(current);
    } catch (error) {
      errors += 1;
      if (firstError === null) firstError = `listing ${current} remotely: ${describe(error)}`;
      logger.warn(`listing ${current} on the remote failed`, error);
      continue;
    }
    // A remote that reports an incomplete listing has just told us its absences
    // are meaningless, and that is precisely what the deletion gate acts on.
    if (!listing.complete) complete = false;
    for (const entry of listing.entries) {
      remoteByPath.set(entry.path, entry);
      if (!entry.isCollection || queued.has(entry.path) || visited.has(entry.path)) {
        continue;
      }

      queued.add(entry.path);
      queue.push(entry.path);
    }
  }

  if (errors > 0) complete = false;
  return {
    localByPath,
    remoteByPath,
    base: await baseForVisited(localStub, replicationId, visited),
    complete,
    errors,
    firstError,
    remaining: queue.length,
    cursor: queue.length > 0 ? cursor : null,
  };
}

/**
 * The recorded base, restricted to the subtree this slice actually opened.
 *
 * A base row for a collection the slice never visited would be indistinguishable
 * from a deletion, which is the exact confusion the gate exists to prevent.
 */
async function baseForVisited(localStub: LocalReplicaStub, replicationId: string, visited: ReadonlySet<string>): Promise<PlanBase[]> {
  const base: PlanBase[] = [];
  const recorded = await localStub.loadReplicaStateRows(replicationId);
  for (const row of recorded) {
    const parent = parentOf(row.path);
    if (row.path === '') continue;
    if (visited.has(row.path) || visited.has(parent)) base.push(toPlanBase(row));
  }
  return base;
}

function toPlanBase(row: ReplicaStateRow): PlanBase {
  return {
    path: row.path,
    isCollection: row.isCollection,
    localEtag: row.localEtag,
    localMtime: row.localMtime,
    localSize: row.localSize,
    remoteEtag: row.remoteEtag,
    remoteMtime: row.remoteMtime,
    remoteSize: row.remoteSize,
    contentType: row.contentType,
  };
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { collectSlice, parentOf, toPlanBase, describe };
export type { CollectSliceOptions };
