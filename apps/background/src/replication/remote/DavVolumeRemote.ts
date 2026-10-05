import { RemoteUnavailableError } from '@durable-dav/backend-services/replication';
import type { RemoteEntry, RemoteListing, RemoteVolume } from '@durable-dav/backend-services/replication';
import { normalizeVolumeKey } from '@durable-dav/webdav';

/**
 * Strip leading and trailing slashes. One pass; see `DavHttpRemote.trimSlashes`.
 */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/**
 * The RPC surface this adapter needs from a volume Durable Object.
 *
 * Declared locally rather than imported as the `DavVolumeWorker` type, for the same
 * reason Edge-Git's runners declare a local `MirrorStub`: `apps/background`
 * importing its own class as a *type* into a collaborator that the class itself
 * constructs is a cycle, and a structural interface is also what makes a fake
 * usable in tests without a module mock.
 */
interface ReplicaVolumeStub {
  /**
   * Direct children of one collection, **with an explicit statement of whether
   * the listing is complete**.
   *
   * Not a bare array. A listing is the only evidence the sync engine has that a
   * path is gone, so "did this see everything?" is not an implementation detail
   * of the stub — it is the input to the deletion gate. Carrying it in the
   * return type means a future truncating implementation has to answer the
   * question rather than have `complete: true` assumed for it here.
   */
  listReplicaChildren(path: string): Promise<ReplicaListing>;
  readReplicaStream(path: string): Promise<ReadableStream<Uint8Array> | null>;
  readReplicaBytes(path: string): Promise<Uint8Array | null>;
  applyReplicaOperations(replicationId: string, operations: unknown[]): Promise<{ applied: number; failed: number; error: string | null }>;
}

/**
 * What the volume DO reports for one collection listing.
 *
 * Structurally identical to the `ReplicaListing` that `VolumeReplicationRpc`
 * declares and returns. It is redeclared rather than imported because this
 * module is reachable *from* the DO class that constructs it, so the import
 * would be a cycle — the same reason `ReplicaVolumeStub` below is structural
 * rather than `DavVolumeWorker`.
 */
type ReplicaListing = {
  entries: RemoteEntry[];
  /**
   * `false` means the listing covered less than the collection, so its
   * absences are not evidence that anything is gone.
   */
  complete: boolean;
};

type DavVolumeRemoteOptions = {
  /**
  Resolves the Durable Object for a sibling bucket.
  */
  getStub: (owner: string, volume: string) => ReplicaVolumeStub;
  owner: string;
  volume: string;
  /**
  Subdirectory inside the sibling bucket to sync into.
  */
  remotePath?: string;
  /**
  The replication whose bookkeeping the writes advance.
  */
  replicationId: string;
};

/**
 * `RemoteVolume` backed by another Durable-DAV bucket.
 *
 * ## Why this adapter exists rather than an HTTP replication to our own URL
 *
 * `RemoteUrlPolicy` refuses loopback and private addresses *by design*, because
 * those are exactly the addresses an SSRF attack aims at. A bucket replicating to
 * its neighbour on the same deployment is provably not that, and routing it through
 * public egress would both trip the policy and pay a network hop for bytes that
 * never leave the account.
 *
 * The trade is that this path bypasses `DavAuth` and the read-only credential
 * check, because the Durable Object has no authentication of its own — it is only
 * reachable through a binding. That is the same trust boundary the username-rename
 * transfer RPCs already sit behind, and it is why the runner only ever constructs
 * this from a configuration row the owner created through an owner-only route.
 */
class DavVolumeRemote implements RemoteVolume {
  private readonly root: string;

  private readonly stub: ReplicaVolumeStub;

  private readonly replicationId: string;

  private readonly owner: string;

  private readonly volume: string;

  constructor(options: DavVolumeRemoteOptions) {
    this.root = trimSlashes(options.remotePath ?? '');
    this.stub = options.getStub(options.owner, options.volume);
    this.replicationId = options.replicationId;
    this.owner = options.owner;
    this.volume = options.volume;
  }

  /**
   * Map a path from the replication's namespace into the sibling volume's.
   *
   * Every path the sync engine handles — from `buildReplicationPlan`, from the
   * recorded base, from a decision — is relative to the replication root, and that
   * is the invariant `DavHttpRemote` satisfies for free because its `PROPFIND` is
   * already scoped to it. A sibling listing is *not* scoped, so this is where the two
   * get reconciled.
   *
   * One direction only, always toward the volume. An earlier version rebased on the
   * way out and stripped on the way in, which inverted the two: with a configured
   * `remotePath`, every listed entry carried the prefix and so matched no local path,
   * and every write resolved to the replication root and refused. Both failures are
   * silent — the sync reported a clean run having moved nothing — which is why the
   * direction is stated here rather than left to the call sites.
   *
   * Refusing `..` mirrors `normalizeRemotePath`: a path that has to be rewritten to
   * be safe is one that was constructed to escape.
   */
  private withRoot(remotePath: string): string {
    if (remotePath.split('/').some((segment) => segment === '..' || segment === '.')) {
      throw new RemoteUnavailableError(`refusing to resolve a replication path containing "..": ${remotePath}`);
    }
    return this.root === '' ? remotePath : remotePath === '' ? this.root : `${this.root}/${remotePath}`;
  }

  /**
   * A listing that failed outright becomes `RemoteUnavailableError`, which the
   * collector counts as an error and which closes the deletion gate.
   *
   * The DO half pairs this with `DavRepository.requireChildren` rather than the
   * degrading `listChildren`: a stub that answered `[]` for an unreadable
   * collection would never reach this catch, and an empty listing is exactly
   * what a mass deletion looks like to the planner.
   */
  private async listChildren(innerPath: string): Promise<ReplicaListing> {
    try {
      return await this.stub.listReplicaChildren(innerPath);
    } catch (error) {
      throw new RemoteUnavailableError(`listing ${innerPath} on the sibling volume failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async list(path: string): Promise<RemoteListing> {
    const inner = this.withRoot(path);
    const listing = await this.listChildren(inner);
    const children = listing.entries;
    // `listReplicaChildren` answers in the *volume's* coordinates whatever
    // collection it was asked about, and it includes that collection's own entry.
    // Two corrections are needed to land in the caller's namespace:
    //
    // 1. Drop the self entry — the requested collection is not its own child, and
    //    leaving it in made the planner mirror the target subdirectory itself as a
    //    local directory.
    // 2. Strip `inner + '/'` from each child and re-attach the caller's path.
    //    Without this every entry carried an extra segment, matched no local path,
    //    and was treated as new on every pass — the file synced and then stayed
    //    invisible.
    const volumePrefix = inner === '' ? '' : `${inner}/`;
    const callerPrefix = path === '' ? '' : `${path}/`;
    return {
      entries: children
        .filter((entry) => entry.path !== inner)
        .map((entry) => ({ ...entry, path: `${callerPrefix}${entry.path.slice(volumePrefix.length)}` })),
      // Propagated rather than asserted. This used to be a hardcoded `true` on
      // the reasoning that "a single indexed read either succeeded or threw" —
      // which was true of the read and false of the answer, because the read's
      // failure was being absorbed one layer down in the DO. Reporting the
      // volume's own answer means a partial listing cannot be laundered into a
      // trustworthy one on the way through here.
      complete: listing.complete,
    };
  }

  public async stat(path: string): Promise<RemoteEntry | null> {
    if (path === '') return null;
    const inner = this.withRoot(path);
    const slash = inner.lastIndexOf('/');
    const parent = slash === -1 ? '' : inner.slice(0, slash);
    const siblings = await this.listChildren(parent);
    const found = siblings.entries.find((entry) => entry.path === inner);
    // A partial listing that did not reach this path is an unknown, not an
    // absence. Reporting `null` here would let a caller treat "could not see it"
    // as "it is gone", which is the same conflation the gate exists to stop.
    if (found === undefined && !siblings.complete) {
      throw new RemoteUnavailableError(`listing ${parent} on the sibling volume was incomplete`);
    }
    return found === undefined ? null : { ...found, path };
  }

  public async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.stub.readReplicaStream(this.withRoot(path));
  }

  public async writeFile(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { contentType: string | null; ifMatch: string | null },
  ): Promise<{ etag: string | null }> {
    if (path === '') throw new RemoteUnavailableError('cannot write to the replication root itself');
    const inner = this.withRoot(path);
    const result = await this.stub.applyReplicaOperations(this.replicationId, [
      { op: 'write', path: inner, contentType: options.contentType, data: body },
    ]);
    if (result.failed > 0) {
      throw new RemoteUnavailableError(`writing ${inner} to the sibling volume failed: ${result.error ?? 'unknown error'}`);
    }
    // The sibling's ETag is recomputed locally from the bytes it just wrote, so there
    // is nothing meaningful to hand back. `null` tells the planner to re-read it on
    // the next pass, which is correct and costs one listing.
    // `ifMatch` is accepted and ignored here: the sibling is this same codebase and
    // cannot race itself, and forwarding a precondition the sibling RPC does not
    // honour would make every write fail rather than merely go unchecked.
    return { etag: null };
  }

  public async makeCollection(path: string): Promise<void> {
    if (path === '') return;
    const inner = this.withRoot(path);
    const result = await this.stub.applyReplicaOperations(this.replicationId, [{ op: 'mkdir', path: inner }]);
    if (result.failed > 0) {
      throw new RemoteUnavailableError(`creating ${inner} on the sibling volume failed: ${result.error ?? 'unknown error'}`);
    }
  }

  public async remove(path: string, options: { ifMatch: string | null; recursive: boolean }): Promise<void> {
    if (path === '') throw new RemoteUnavailableError('refusing to delete the replication root');
    const inner = this.withRoot(path);
    const result = await this.stub.applyReplicaOperations(this.replicationId, [{ op: 'unlink', path: inner, recursive: options.recursive }]);
    if (result.failed > 0) {
      throw new RemoteUnavailableError(`deleting ${inner} from the sibling volume failed: ${result.error ?? 'unknown error'}`);
    }
  }

  public async probe(): Promise<{ davClasses: string[] }> {
    try {
      await this.listChildren(this.root);
      // A sibling Durable-DAV bucket is this same codebase, so its RFC 4918
      // compliance is not in question the way a third-party server's is.
      return { davClasses: ['1', '2'] };
    } catch (error) {
      throw new RemoteUnavailableError(`sibling volume ${this.stubKey} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
  The sibling's `owner/volume` key, for error messages.
  */
  private get stubKey(): string {
    return normalizeVolumeKey(this.owner, this.volume);
  }
}

export { DavVolumeRemote };
export type { DavVolumeRemoteOptions, ReplicaVolumeStub };
