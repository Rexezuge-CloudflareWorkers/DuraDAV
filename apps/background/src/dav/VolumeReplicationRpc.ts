import type { DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';
import { ensureReplicationSchema, forgetReplicaPaths, forgetReplication, loadReplicaState, saveReplicaState } from '@durable-dav/dav-store';
import type { ReplicaStateRow, ReplicaStateWrite } from '@durable-dav/dav-store';
import { fsPathOf, isValidInnerPath } from './DavContext';
import { DavRepository } from './DavRepository';
import * as ops from './replicaOperations';
import type { ReplicaEntry } from './replicaOperations';
import { errorMessageOf, truncateReplicationReason } from '@durable-dav/backend-services/replication';

/**
 * One operation from a replication plan, as the DO applies it.
 *
 * The union is closed and flat on purpose: it crosses an RPC boundary, so every
 * variant has to be structurally serialisable, and a nested "apply this closure"
 * shape would put the *decision* logic on this side of the wire. The decision is
 * `buildReplicationPlan`'s, and it is pure, and it is tested as a function.
 */
type ReplicaOperation =
  /**
  Create a collection. Idempotent — an existing one is not an error.
  */
  | { op: 'mkdir'; path: string }
  /**
  Write bytes. `data` is a stream when the caller has one.
  */
  | {
      op: 'write';
      path: string;
      contentType: string | null;
      data: ReadableStream<Uint8Array> | Uint8Array;
    }
  /**
  Remove a resource, recursively for a collection.
  */
  | { op: 'unlink'; path: string; recursive: boolean }
  /**
  Copy an existing path to a new one — the keep-both conflict write.
  */
  | { op: 'copy'; from: string; to: string }
  /**
  Refresh the recorded base for a path that needs no transfer.
  */
  | { op: 'record'; state: ReplicaStateRow }
  /**
  Forget a path that exists on neither side any more.
  */
  | { op: 'forget'; path: string }
  /**
  Touch one path's bookkeeping (`synced_at`) with no other change.
  */
  | { op: 'touch'; path: string };

type ReplicaApplyResult = {
  applied: number;
  failed: number;
  /**
  First error, truncated. One bad path must not hide the rest.
  */
  error: string | null;
};

/**
 * One collection listing, carrying whether it is complete.
 *
 * The flag is part of the answer rather than a property of the transport
 * because a listing is the sync engine's only evidence that a path is gone: if
 * a listing silently covered less than it claims, every missing path would
 * queue as a deletion. `DavVolumeRemote` mirrors this into `RemoteListing`, and
 * `collectSlice` closes the deletion gate on `complete: false`.
 *
 * A structurally-identical type is declared on the adapter side, in
 * `DavVolumeRemote`, which needs it to describe the stub it calls without
 * importing this module — `DavVolumeWorker` constructs the adapter, so an
 * import the other way is a cycle.
 */
type ReplicaListing = {
  entries: ReplicaEntry[];
  complete: boolean;
};

/**
 * The Durable Object half of scheduled replication.
 *
 * Split out of `DavVolumeWorker` for the same reason `VolumeTransfer` was: this
 * is a different concern from answering RFC 4918 requests, and it is reached
 * only by the cron runner, never by a `DAV:` method. Keeping it here also keeps
 * the facade's god-file count where it is.
 *
 * ## Locks
 *
 * Replication writes bypass `DavLockGuard` entirely, and that is deliberate
 * rather than an oversight. A lock is a *client* coordination device: it says
 * "someone has this open in an editor, do not touch it behind their back".
 * Nothing in this code is a client, and honouring locks would mean a sync
 * silently skips whatever a desktop client happens to have open — which is
 * exactly the file an owner most wants backed up. The trade is the mirror image
 * of the credential rule: replication is a principal with full write authority
 * over the volume, and it is reachable only from the owner-scoped config.
 */
class VolumeReplicationRpc {
  constructor(
    private readonly dofs: DofsFs,
    private readonly sql: DurableSqlStorage,
  ) {}

  /**
   * Direct children of one collection, plus the collection itself.
   *
   * Depth-1 rather than a whole-tree listing, for the same reasons
   * `DavHttpRemote` does it that way: a resumed sweep needs a position to
   * resume from, and `listVolumeEntries`' single unbounded array has none.
   */
  public listChildren(path: string): ReplicaListing {
    this.ensure();
    const parent = path === '' ? '' : path;
    if (!isValidInnerPath(parent)) return { entries: [], complete: false };
    const repo = new DavRepository(this.dofs, this.sql);
    const entries: ReplicaEntry[] = [];
    if (parent !== '') {
      const self = ops.describe(repo, parent);
      if (self !== null) entries.push(self);
    }
    // `requireChildren`, not `listChildren`, and this is the whole reason the
    // method exists. Both degrade a dofs error to "this collection is empty",
    // which the sync planner reads as "every resource here was deleted" and
    // queues as such — the mass deletion the engine's deletion gate exists to
    // prevent. The throwing form makes a storage blip a thrown error instead,
    // which `DavVolumeRemote` turns into `RemoteUnavailableError`, which
    // `collectSlice` counts, which closes the gate for the pass.
    //
    // It said so in a comment here for a while while calling `listChildren`
    // directly underneath, which is the failure mode this file is now shaped
    // to make impossible: `describe` is also a deciding read, so it pairs with
    // `requireStatInner` rather than `statInner` for the same reason.
    const names = repo.requireChildren(parent);
    for (const name of names) {
      const child = repo.childInner(parent, name);
      if (!isValidInnerPath(child)) continue;
      const described = ops.describe(repo, child);
      if (described !== null) entries.push(described);
    }
    // Reached only if every read above did, because each of them throws on
    // failure rather than degrading. That is what lets this be `true` instead of
    // a guess — an incomplete listing cannot reach this return at all.
    return { entries, complete: true };
  }

  public loadState(replicationId: string): ReplicaStateRow[] {
    this.ensure();
    return Array.from(loadReplicaState(this.sql, replicationId).values());
  }

  public forget(replicationId: string): void {
    this.ensure();
    forgetReplication(this.sql, replicationId);
  }

  /**
   * Apply one operation.
   *
   * Its own method so the `switch` sits one level above the loop rather than
   * inside it — and so a new operation is added by adding a case, not by growing
   * a nested block.
   */
  private async applyOne(repo: DavRepository, replicationId: string, operation: ReplicaOperation, records: ReplicaStateWrite[], forgetPaths: string[]): Promise<void> {
    switch (operation.op) {
      case 'mkdir': {
        ops.mkdir(this.dofs, repo, operation.path);
        return;
      }
      case 'write': {
        await ops.write(this.dofs, repo, operation.path, operation.contentType, operation.data);
        return;
      }
      case 'unlink': {
        ops.unlink(this.dofs, this.sql, repo, operation.path, operation.recursive);
        return;
      }
      case 'copy': {
        await ops.copy(this.dofs, this.sql, repo, operation.from, operation.to);
        return;
      }
      case 'record': {
        records.push(operation.state);
        return;
      }
      case 'forget': {
        forgetPaths.push(operation.path);
        return;
      }
      case 'touch': {
        const existing = loadReplicaState(this.sql, replicationId).get(operation.path);
        if (existing !== undefined) records.push({ ...existing, syncedAt: Date.now() });
        return;
      }
      default: {
        return;
      }
    }
  }

  /**
   * Apply a bounded batch of plan operations.
   *
   * Batched rather than one RPC per operation so a slice is a single round trip
   * and a partially-applied slice is impossible: the whole batch either runs or
   * the first failure stops it and the count is reported. The runner treats a
   * non-zero `failed` as a dirty pass, which closes `pass_started_at` and
   * therefore suppresses every deletion for that tick.
   */
  public async apply(replicationId: string, operations: readonly ReplicaOperation[]): Promise<ReplicaApplyResult> {
    this.ensure();
    const records: ReplicaStateWrite[] = [];
    const forgetPaths: string[] = [];
    let applied = 0;
    let failed = 0;
    let error: string | null = null;

    // One repository for the batch, not one per operation. It is a two-field
    // value object over `dofs`/`sql`, so this is a readability change as much as
    // an allocation one — but a 200-operation slice was constructing 200 of them.
    const repo = new DavRepository(this.dofs, this.sql);
    for (const operation of operations) {
      try {
        await this.applyOne(repo, replicationId, operation, records, forgetPaths);
        applied += 1;
      } catch (caught) {
        failed += 1;
        if (error === null) {
          error = truncateReplicationReason(errorMessageOf(caught));
        }
        // Keep going. One unmappable path (a name the remote invented, a file
        // that vanished mid-pass) must not abandon the other 199 in the slice.
      }
    }

    if (records.length > 0) saveReplicaState(this.sql, replicationId, records, Date.now());
    if (forgetPaths.length > 0) forgetReplicaPaths(this.sql, replicationId, forgetPaths);
    return { applied, failed, error };
  }

  /**
  Read one file's bytes as a stream, for pushing to the remote.
  */
  public readStream(path: string): ReadableStream<Uint8Array> | null {
    if (path === '' || !isValidInnerPath(path)) return null;
    const repo = new DavRepository(this.dofs, this.sql);
    const stat = repo.statInner(path);
    if (!stat.exists || stat.isDirectory) return null;
    try {
      return this.dofs.readFile(fsPathOf(path), {});
    } catch {
      return null;
    }
  }

  /**
  Read one file whole. Only for the ambiguity hash, which is opt-in.
  */
  public readBytes(path: string): Uint8Array | null {
    if (path === '' || !isValidInnerPath(path)) return null;
    const repo = new DavRepository(this.dofs, this.sql);
    const stat = repo.statInner(path);
    if (!stat.exists || stat.isDirectory) return null;
    try {
      return new Uint8Array(this.dofs.read(fsPathOf(path), {}).slice(0));
    } catch {
      return null;
    }
  }

  private ensure(): void {
    ensureReplicationSchema(this.sql);
  }

}

export { VolumeReplicationRpc };
export type { ReplicaOperation, ReplicaApplyResult, ReplicaListing };
export type { ReplicaEntry } from './replicaOperations';
