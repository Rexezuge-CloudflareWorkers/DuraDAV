/**
 * The one shape a replication target has to present.
 *
 * Two implementations exist — `DavHttpRemote` (any WebDAV server over HTTPS)
 * and `DavVolumeRemote` (a sibling bucket on this deployment, over DO RPC) — and
 * the sync engine is written against this interface alone. That is what makes
 * "Durable-DAV to Durable-DAV" a configuration choice rather than a second code
 * path that has to be kept in step with the first.
 *
 * No imports, deliberately. This file is the contract between the pure planner
 * in `backend-services` and the transports in `apps/background`, and both of
 * those sit on either side of it.
 */

import type { PlanSide } from '../types';

/**
 * A resource as the remote reports it.
 *
 * An alias of `PlanSide` rather than a parallel type. The planner consumes
 * observations from both sides through one shape, so a second declaration would
 * be a second thing to keep in step — and the interesting question ("does a
 * remote `getlastmodified` mean the same thing as our `mtime`?") deserves one
 * answer, not two that can drift.
 */
type RemoteEntry = PlanSide;

type RemoteListing = {
  entries: RemoteEntry[];
  /**
   * Did this listing cover the whole subtree honestly?
   *
   * `false` means the server truncated, refused, or the walk hit a collection it
   * could not read. It is the single most important field in this file: the sync
   * engine gates every deletion on it, because an absence observed through an
   * incomplete listing is not evidence of anything.
   */
  complete: boolean;
};

/**
 * A remote that cannot be reached at all.
 *
 * Distinct from an empty listing: the first is a failure to retry, the second is
 * a fact about the target. Conflating them is how a sync deletes a whole
 * directory because one `PROPFIND` returned `403`.
 */
class RemoteUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

interface RemoteVolume {
  /**
   * Direct children of one collection, plus the collection itself.
   *
   * Depth-1 per collection rather than `Depth: infinity`: many servers refuse
   * infinity outright, and a single unbounded response has no natural place to
   * resume from when a slice runs out of budget.
   */
  list(path: string): Promise<RemoteListing>;

  stat(path: string): Promise<RemoteEntry | null>;

  /**
  Stream a file down. `null` when it is absent.
  */
  readFile(path: string): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Write a file up.
   *
   * `ifMatch` is the ETag the caller last saw, sent as `If-Match` so a concurrent
   * write by a human is rejected rather than silently overwritten. `null` means
   * "no precondition", which is correct only for a first write.
   */
  writeFile(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { contentType: string | null; ifMatch: string | null },
  ): Promise<{ etag: string | null }>;

  makeCollection(path: string): Promise<void>;

  /**
   * Remove a resource.
   *
   * `recursive` is honoured where the protocol allows it and emulated by emptying
   * the subtree first where it does not, because a target that silently refuses
   * to delete a non-empty collection would wedge the sweep.
   */
  remove(path: string, options: { ifMatch: string | null; recursive: boolean }): Promise<void>;

  /**
   * Is this reachable, and does it speak WebDAV at all?
   *
   * Separated from `list` so "target misconfigured" and "target is empty" are
   * different answers. A URL that resolves to a login page answering `200` is the
   * most common configuration mistake, and it should be reported as such rather
   * than as a mysterious empty listing.
   */
  probe(): Promise<{ davClasses: string[] }>;
}

export { RemoteUnavailableError };
export type { RemoteEntry, RemoteListing, RemoteVolume };
