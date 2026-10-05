import { getDeadProperties, upsertDeadProperty, upsertNode } from '@durable-dav/dav-store';
import type { DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';
import { getParentPath, type DeadProperty } from '@durable-dav/webdav';
import { fsPathOf, isValidInnerPath } from './DavContext';
import { DavRepository } from './DavRepository';
import { base64ToBytes, bytesToBase64 } from '@durable-dav/shared/utils';

/**
 * Username-rename transfer primitives.
 *
 * Split out of `DavVolumeWorker` (which was 351 LOC over the 300 soft limit)
 * because these are a different concern from WebDAV request handling: nothing
 * here is reachable from a `DAV:` method. They are RPCs the front door calls
 * to copy a volume between Durable Objects during a username rename.
 *
 * Locks are never copied (RFC 4918 §9.8); dead props follow the file bytes.
 */

type VolumeEntry = {
  path: string;
  isCollection: boolean;
  contentType: string | null;
  etag: string | null;
  props: DeadProperty[];
};

class VolumeTransfer {
  constructor(
    private readonly dofs: DofsFs,
    private readonly sql: DurableSqlStorage,
  ) {}

  /**
  Every entry in the volume, depth-first.
  */
  public listEntries(): VolumeEntry[] {
    const repo = new DavRepository(this.dofs, this.sql);
    let names: string[];
    try {
      names = repo.listRecursive('');
    } catch {
      return [];
    }
    const entries: VolumeEntry[] = [];
    for (const name of names) {
      const innerPath = repo.childInner('', name);
      if (!isValidInnerPath(innerPath)) continue;
      const st = repo.statInner(innerPath);
      if (!st.exists) continue;
      const meta = repo.readMeta(innerPath);
      let props: DeadProperty[] = [];
      try {
        props = getDeadProperties(this.sql, innerPath);
      } catch {
        props = [];
      }
      entries.push({
        path: innerPath,
        isCollection: st.isDirectory,
        contentType: meta.contentType ?? null,
        etag: meta.etag ?? null,
        props,
      });
    }
    return entries;
  }

  public readFile(path: string): { dataBase64: string; contentType: string | null } | null {
    if (path === '' || !isValidInnerPath(path)) return null;
    const repo = new DavRepository(this.dofs, this.sql);
    const st = repo.statInner(path);
    if (!st.exists || st.isDirectory) return null;
    try {
      // `slice(0)` detaches the view from the (possibly much larger) backing
      // buffer before the copy, so the base64 pass only sees the file.
      const bytes = new Uint8Array(this.dofs.read(fsPathOf(path), {}).slice(0));
      return { dataBase64: bytesToBase64(bytes), contentType: repo.readMeta(path).contentType ?? null };
    } catch {
      return null;
    }
  }

  /**
   * Write one entry, creating parents as needed.
   *
   * Throws on an invalid path. This must not silently skip: the caller purges
   * the source volume once every entry is written, so a skipped entry turns a
   * username rename into unrecoverable data loss. Throwing engages the
   * caller's existing rollback.
   */
  public async writeEntry(entry: {
    path: string;
    isCollection: boolean;
    contentType?: string | null;
    etag?: string | null;
    dataBase64?: string | null;
    props?: DeadProperty[];
  }): Promise<void> {
    if (!isValidInnerPath(entry.path) || entry.path === '') {
      throw new Error(`writeVolumeEntry: invalid volume entry path ${JSON.stringify(entry.path)}`);
    }
    const repo = new DavRepository(this.dofs, this.sql);
    const parent = getParentPath(entry.path);
    if (parent !== '') {
      try {
        this.dofs.mkdir(fsPathOf(parent), { recursive: true });
      } catch {
        // Parent may already exist; file/collection op surfaces real errors.
      }
      const segments = parent.split('/');
      for (let i = 1; i <= segments.length; i += 1) {
        repo.upsertCollectionNode(segments.slice(0, i).join('/'), Date.now());
      }
    }
    if (entry.isCollection) {
      try {
        this.dofs.mkdir(fsPathOf(entry.path), { recursive: false });
      } catch {
        // Existing collection is fine; metadata upsert below still applies.
      }
      repo.upsertCollectionNode(entry.path, Date.now());
    } else {
      const bytes = entry.dataBase64 ? base64ToBytes(entry.dataBase64) : new Uint8Array();
      await this.dofs.writeFile(fsPathOf(entry.path), bytes.slice().buffer, {});
      const now = Date.now();
      repo.upsertFileNode(
        entry.path,
        entry.contentType ?? 'application/octet-stream',
        entry.etag ?? `"${bytes.byteLength.toString(16)}-${now.toString(16)}"`,
        now,
      );
    }
    const props = entry.props ?? [];
    for (const prop of props) {
      try {
        upsertDeadProperty(this.sql, entry.path, prop);
      } catch {
        // Dead-prop copy is best-effort; the file bytes are already durable.
      }
    }
  }

  /**
  Create the zero-byte file that backs a lock-null resource.

  The row is stamped `lockNull` so `handleUnlock` can tell this apart from an
  empty file the client uploaded. RFC 4918 §7.3 makes the two the same
  resource, but it also says a locked empty resource "SHOULD NOT disappear when
  its lock goes away" — which cannot be honoured by inspecting size alone, since
  a zero-byte `PUT` is indistinguishable from one of these. The flag is the only
  thing that carries the difference.
  */
  public async writeEmptyFile(innerPath: string): Promise<boolean> {
    try {
      await this.dofs.writeFile(fsPathOf(innerPath), new Uint8Array().buffer, {});
    } catch {
      return false;
    }
    try {
      const now = Date.now();
      upsertNode(this.sql, innerPath, { isCollection: false, mtime: now, crtime: now, lockNull: true });
    } catch {
      // Metadata is best-effort; the zero-byte file already exists. A missing
      // flag costs one abandoned lock-null file, which is the old behaviour.
    }
    return true;
  }
}

export { VolumeTransfer };
export type { VolumeEntry };
