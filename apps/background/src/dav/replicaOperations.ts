import { deleteNodeCascade, getDeadProperties, upsertDeadProperty, upsertNode } from '@durable-dav/dav-store';
import type { DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';
import { getParentPath } from '@durable-dav/webdav';
import { fsPathOf, isValidInnerPath } from './DavContext';
import { DavRepository } from './DavRepository';

/**
 * The filesystem mutators a replication pass performs inside a volume.
 *
 * Split from `VolumeReplicationRpc`, which is the Durable Object's *RPC surface* — what a
 * sibling bucket may be asked. This module is what those calls do once they arrive, and
 * it is deliberately not part of any request path: no `dav/methods/*` module reaches it,
 * because a replication write must not be able to satisfy a client's `ETag` precondition
 * or ride in on a front-door request's authorization.
 *
 * Every function takes the volume's `dofs` and `sql` explicitly and refuses an invalid
 * path rather than normalizing it. A path that had to be rewritten to be safe is a path
 * someone constructed to leave the volume, and the caller — a plan built from two
 * listings — is exactly where that would come from.
 *
 * ## Reads here fail closed
 *
 * Every read in this module feeds a planner that treats an absence as a
 * deletion, so none of them degrade a failed read into a benign-looking value.
 * `describe` uses `DavRepository.requireStatInner` for that reason:
 * `statInner` reports an unreadable path as `exists: false`, which drops the
 * entry from the listing and reads as "deleted on this side".
 */

/**
A resource as the sync engine sees it: validators, never bytes.
*/
type ReplicaEntry = {
  path: string;
  isCollection: boolean;
  etag: string | null;
  mtime: number | null;
  size: number | null;
  contentType: string | null;
};

/**
 * One resource, or `null` when there is nothing at that path.
 *
 * `mtime` prefers the recorded metadata over the filesystem's, because the recorded value
 * is what a front-door `PUT` stamped and the sync planner compares; the filesystem's is
 * the fallback for a node whose metadata row is missing.
 */
function describe(repo: DavRepository, path: string): ReplicaEntry | null {
  // `requireStatInner`, not `statInner`: this answer decides whether a resource
  // is still present, and `statInner` reports a failed read as
  // `exists: false`. One dofs error would then drop an entry from a listing,
  // which the planner reads as a deletion on that path — the same trap
  // `VolumeReplicationRpc.listChildren` walks into if it degrades its listing.
  const stat = repo.requireStatInner(path);
  if (!stat.exists) return null;
  const meta = repo.readMeta(path);
  return {
    path,
    isCollection: stat.isDirectory,
    etag: meta.etag ?? null,
    mtime: meta.mtime ?? stat.mtime ?? null,
    size: typeof stat.size === 'number' ? stat.size : null,
    contentType: meta.contentType ?? null,
  };
}

/**
 * Create a collection and every missing ancestor's metadata row.
 *
 * Ancestors are created too, because a plan can legitimately order a nested `mkdir`
 * after a sibling it does not depend on, and a `MKCOL` on a collection whose parent row
 * is missing leaves the tree unreadable to a `Depth: 1` listing.
 */
function mkdir(dofs: DofsFs, repo: DavRepository, path: string): void {
  if (path === '' || !isValidInnerPath(path)) throw new Error(`replication mkdir: invalid path ${JSON.stringify(path)}`);
  const parent = getParentPath(path);
  if (parent !== '') {
    try {
      dofs.mkdir(fsPathOf(parent), { recursive: true });
    } catch {
      // Already present; the metadata upsert below still applies.
    }
    const segments = parent.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      repo.upsertCollectionNode(segments.slice(0, i).join('/'), Date.now());
    }
  }
  try {
    dofs.mkdir(fsPathOf(path), { recursive: false });
  } catch {
    // Exists. `MKCOL` on an existing collection is 405, not a failure.
  }
  repo.upsertCollectionNode(path, Date.now());
}

/**
 * Write a file, creating its parent collections first.
 *
 * Streamed straight through when the caller has one. The quota check inside
 * `dofs.writeFile` runs *before* the unlink (see `patches/dofs@0.1.0.patch`), so an
 * over-quota replication write reports 507 instead of truncating the file it was
 * replacing — the ordering that makes the quota failure safe rather than destructive.
 */
async function write(dofs: DofsFs, repo: DavRepository, path: string, contentType: string | null, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
  if (path === '' || !isValidInnerPath(path)) throw new Error(`replication write: invalid path ${JSON.stringify(path)}`);
  const parent = getParentPath(path);
  if (parent !== '') mkdir(dofs, repo, parent);
  await dofs.writeFile(fsPathOf(path), data as Parameters<DofsFs['writeFile']>[1], {});
  const now = Date.now();
  // The byte count is only known for a buffered payload. A stream's length is
  // unknown until it is drained, so the ETag falls back to a timestamp-only
  // form — which is still a valid validator, just a weaker one, and the next
  // `PROPFIND` replaces it anyway.
  const size = data instanceof Uint8Array ? data.byteLength : 0;
  repo.upsertFileNode(path, contentType ?? 'application/octet-stream', `"${size.toString(16)}-${now.toString(16)}"`, now);
}

function unlink(dofs: DofsFs, sql: DurableSqlStorage, repo: DavRepository, path: string, recursive: boolean): void {
  if (path === '' || !isValidInnerPath(path)) throw new Error(`replication unlink: invalid path ${JSON.stringify(path)}`);
  const stat = repo.statInner(path);
  if (!stat.exists) {
    deleteNodeCascade(sql, path);
    return;
  }
  if (stat.isDirectory) {
    // dofs `rmdir` refuses a non-empty collection, so a recursive delete has
    // to unlink the children first — the same shape `DavHttpRemote.remove`
    // uses for a server that refuses `Depth: infinity`.
    if (recursive) {
      for (const child of repo.listRecursive(path)) {
        const childStat = repo.statInner(child);
        if (childStat.exists && !childStat.isDirectory) {
          try {
            dofs.unlink(fsPathOf(child));
          } catch {
            // Already gone; the metadata cascade below is the backstop.
          }
        }
      }
    }
    dofs.rmdir(fsPathOf(path), { recursive });
  } else {
    dofs.unlink(fsPathOf(path));
  }
  deleteNodeCascade(sql, path);
}

/**
 * Copy a resource within the volume.
 *
 * `dofs` has no copy, so this is read-then-write and needs the bytes in
 * memory. Bounded by `MAX_FILE_BYTES` because it is only ever used for the
 * conflict copy of a single file — a use that reaches the size cap should
 * report that rather than allocate a gigabyte inside a Durable Object.
 */
function copy(dofs: DofsFs, sql: DurableSqlStorage, repo: DavRepository, from: string, to: string): void {
  if (from === '' || to === '' || !isValidInnerPath(from) || !isValidInnerPath(to)) {
    throw new Error(`replication copy: invalid paths ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  }
  const stat = repo.statInner(from);
  if (!stat.exists) throw new Error(`replication copy: ${from} does not exist`);
  const meta = repo.readMeta(from);
  if (stat.isDirectory) {
    mkdir(dofs, repo, to);
    // Dead properties follow the resource, same as `VolumeTransfer`.
    for (const prop of getDeadProperties(sql, from)) {
      upsertNode(sql, to, { isCollection: true });
      upsertDeadProperty(sql, to, prop);
    }
    return;
  }
  const bytes = new Uint8Array(dofs.read(fsPathOf(from), {}).slice(0));
  mkdir(dofs, repo, getParentPath(to));
  void dofs.writeFile(fsPathOf(to), bytes.slice().buffer, {});
  const now = Date.now();
  repo.upsertFileNode(to, meta.contentType ?? 'application/octet-stream', `"${bytes.byteLength.toString(16)}-${now.toString(16)}"`, now);
}

export { copy, describe, mkdir, unlink, write };
export type { ReplicaEntry };
