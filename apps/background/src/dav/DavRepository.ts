/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
import { deleteNodeCascade, getDeadProperties, renameNodeCascade, upsertDeadProperty, upsertNode } from '@durable-dav/dav-store';
import type { DirEntry as DofsChildEntry, DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';
import type { DavNodeInfo, LockDetails } from '@durable-dav/webdav';
import { ErrorSanitizationUtil } from '@durable-dav/shared/utils';
import { hrefOf } from './DavContext';
import { DavLockGuard } from './DavLockGuard';
import { lockDetailsFromRow } from './lockRows';
import { DavReadPolicy, type StatResult } from './davReadPolicy';

// Repository over dofs + DO SQLite (why: the DO previously inlined every
// `dav_nodes/props/locks` statement, duplicating `dav-store/meta.ts` and
// swallowing failures per call site; centralizing here keeps SQL in one
// audited place and lets method handlers stay I/O-orchestration only).
//
// The `dofs` half is delegated to `DavReadPolicy`, which owns the one decision
// this class used to make four separate times: how a failed read is answered.
// Every method named `require*` below is the `'throw'` policy and every other one
// is `'degrade'`; the pairing is what keeps a caller that reads absences from
// mistaking a storage fault for a deletion.

interface NodeMeta {
  contentType?: string;
  etag?: string;
  mtime?: number;
  crtime?: number;
}

/**
 * How a failed read is answered. See `listing` for why this is a parameter
 * rather than a naming convention.
 */
class DavRepository {
  private readonly reads: DavReadPolicy;

  constructor(
    private readonly dofs: DofsFs,
    private readonly sql: DurableSqlStorage,
  ) {
    this.reads = new DavReadPolicy(dofs);
  }

  public statInner(innerPath: string): StatResult {
    return this.reads.stat(innerPath, 'degrade');
  }

  /**
   * `statInner` for a caller that will act on the answer.
   *
   * The degrading form reports a failed read as `exists: false`, which is
   * indistinguishable from a deleted resource — so a caller deciding whether a
   * path is still there would treat a storage error as an absence. Every
   * replication listing walk pairs with this one for exactly that reason.
   */
  public requireStatInner(innerPath: string): StatResult {
    return this.reads.stat(innerPath, 'throw');
  }

  /**
   * Recorded metadata for one path, or `{}` when there is no row or the read fails.
   *
   * `'degrade'` only. Every node this class answers for was created by a
   * filesystem operation that writes a metadata row *after* the bytes, so a
   * missing row is a normal state on a fresh volume rather than a fault, and
   * `nodeInfo` falls back to the filesystem's own mtime for it. A caller must not
   * treat the absence of metadata as evidence that the resource is gone.
   */
  public readMeta(innerPath: string): NodeMeta {
    try {
      const rows = this.sql.exec(`SELECT content_type, etag, mtime, crtime FROM dav_nodes WHERE path = ?`, innerPath).toArray();
      const row = rows[0];
      if (!row) return {};
      return {
        contentType: row['content_type'] == null ? undefined : String(row['content_type']),
        etag: row['etag'] == null ? undefined : String(row['etag']),
        mtime: row['mtime'] == null ? undefined : Number(row['mtime']),
        crtime: row['crtime'] == null ? undefined : Number(row['crtime']),
      };
    } catch {
      return {};
    }
  }

  /**
   * Locks that apply to `innerPath`: those held on it directly, plus any
   * `Depth: infinity` lock on an ancestor.
   *
   * The old query matched `path = ?` exactly, so a child of an
   * infinity-locked collection reported no lock — while `DavLockGuard` *did*
   * enforce it for writes. A client therefore saw an unlocked resource and got
   * `423` on write, which is precisely the confusion `lockdiscovery` exists to
   * prevent.
   */
  private applicableLocks(innerPath: string, hrefBase: string): LockDetails[] {
    // The guard's ancestor set, called rather than re-walked. This method had its
    // own `lastIndexOf` loop with its own `MAX_PATH_DEPTH` comparison, under a
    // comment stating it was the same walk the guard used — which is precisely the
    // claim that cannot be trusted, because when the two implementations
    // disagreed by one segment `lockdiscovery` and the 423 guard each reported a
    // different answer for the same resource and neither said so.
    const ancestors = DavLockGuard.ancestorsOf(innerPath);
    const placeholders = ancestors.map(() => '?').join(', ');
    const rows = this.sql
      .exec(
        `SELECT path, token, scope, depth, owner, timeout, expires_at as expiresAt FROM dav_locks WHERE path IN (${placeholders}) AND expires_at > ?`,
        ...ancestors,
        Date.now(),
      )
      .toArray();
    return rows.flatMap((row) => {
      // A row with no token is not a lock; `normalizeLockDetails` would accept
      // the empty string as one, so this is checked before mapping.
      if (String(row['token'] ?? '') === '') return [];
      const lockPath = String(row['path'] ?? '');
      // A depth-0 ancestor lock does not reach this resource.
      if (lockPath !== innerPath && row['depth'] !== 'infinity') return [];
      // `root` is recomputed from the bucket's *current* href base rather than
      // read from the column, so a bucket that switched prefix mode still
      // advertises lock hrefs in the shape it is currently emitting. That is why
      // this call site passes a root instead of using the stored one.
      const details = lockDetailsFromRow(row, hrefOf(hrefBase, lockPath, true));
      return details ? [details] : [];
    });
  }

  /**
   * `hrefBase` is the href anchor, never the request's path base — see
   * `DavBases`. It only ever reaches `hrefOf`, so a `root`-mode bucket reports
   * root-anchored lock hrefs without affecting any lookup.
   */
  public nodeInfo(innerPath: string, hrefBase: string): DavNodeInfo | null {
    const st = this.statInner(innerPath);
    if (!st.exists) return null;
    const meta = this.readMeta(innerPath);
    const mtime = new Date(meta.mtime ?? st.mtime ?? Date.now());
    const crtime = new Date(meta.crtime ?? mtime.getTime());
    let locks: LockDetails[] = [];
    try {
      locks = this.applicableLocks(innerPath, hrefBase);
    } catch (error) {
      // Surfaced, not swallowed: a client that cannot see the real lock state
      // will attempt a write and be refused, which is worse than a 500.
      console.error('nodeInfo lock lookup failed', {
        path: innerPath,
        error: ErrorSanitizationUtil.stackForLog(error),
      });
      throw error;
    }
    return {
      key: innerPath,
      isCollection: st.isDirectory,
      size: st.size,
      etag: meta.etag ?? `"${st.size.toString(16)}-${(meta.mtime ?? st.mtime).toString(16)}"`,
      mtime,
      crtime,
      contentType: meta.contentType,
      // No `contentLanguage`: nothing ever stored one, so the field was
      // permanently `undefined` and `getcontentlanguage` was absent from every
      // PROPFIND while the schema claimed otherwise. Deriving the display name
      // from the path is deliberate — the dropped `dav_nodes.displayname`
      // column was never written.
      displayname: innerPath === '' ? undefined : (innerPath.split('/').pop() ?? undefined),
      locks,
      deadProperties: getDeadProperties(this.sql, innerPath),
    };
  }

  public rootNode(): DavNodeInfo {
    const now = new Date();
    return {
      key: '',
      isCollection: true,
      size: 0,
      etag: undefined,
      mtime: now,
      crtime: now,
      contentType: undefined,
      displayname: undefined,
      locks: [],
      deadProperties: [],
    };
  }

  public listChildren(innerPath: string): string[] {
    return this.reads.list(innerPath, false, 'degrade');
  }

  public listRecursive(innerPath: string): string[] {
    return this.reads.list(innerPath, true, 'degrade');
  }

  /**
   * Direct children for a caller deciding on their absence.
   *
   * The pairing with `listChildren` is the point. `VolumeReplicationRpc` wanted
   * this one — a listing it was going to read absences *from* — and took
   * `listChildren` instead, because the throwing non-recursive variant did not
   * exist and the degrading one was the only one on offer.
   */
  public requireChildren(innerPath: string): string[] {
    return this.reads.list(innerPath, false, 'throw');
  }

  /**
   * Every descendant, for a caller deciding on their absence — lock enumeration
   * over DELETE and MOVE.
   */
  public requireRecursive(innerPath: string): string[] {
    return this.reads.list(innerPath, true, 'throw');
  }

  /**
   * One page of direct children, as `{name, isDirectory}`.
   *
   * Ordering is the server's, not the browser's — see `DavReadPolicy.listPage` on
   * why the trailing binary `name` tiebreak is load-bearing. `'degrade'` only: the
   * pager cannot report an error without inventing a total it does not have, and
   * a wrong page count would be worse than a short page.
   */
  public listChildPage(innerPath: string, offset: number, limit: number): DofsChildEntry[] {
    return this.reads.listPage(innerPath, offset, limit, 'degrade');
  }

  /**
   * Direct child count, for a pager's total and its last-page clamp.
   */
  public countChildren(innerPath: string): number {
    return this.reads.countChildren(innerPath, 'degrade');
  }

  /**
  Child path for a `listDir` entry (handles both relative and absolute returns).
  */
  public childInner(parent: string, name: string): string {
    if (name.startsWith('/')) return name.slice(1);
    return parent === '' ? name : `${parent}/${name}`;
  }

  public upsertFileNode(innerPath: string, contentType: string, etag: string, now: number, crtime?: number): void {
    try {
      // `lockNull: false` is the point: real content was written, so this is no
      // longer a resource that exists only to hold a lock, even if the bytes
      // happen to be zero.
      upsertNode(this.sql, innerPath, { isCollection: false, contentType, etag, mtime: now, crtime, lockNull: false });
    } catch {
      // Metadata is best-effort; file bytes already persisted.
    }
  }

  /**
   * Was this resource created by a LOCK and never written to since?
   *
   * The only question `handleUnlock` needs answered, and the only place the
   * `dav_nodes.lock_null` bit is read. Fails *closed* — an unreadable row is
   * reported as "not a lock-null resource", so a metadata failure leaves the
   * empty file in place instead of deleting a file it cannot classify.
   */
  public isLockNull(innerPath: string): boolean {
    try {
      const rows = this.sql.exec(`SELECT lock_null FROM dav_nodes WHERE path = ?`, innerPath).toArray();
      return rows[0]?.['lock_null'] === 1;
    } catch {
      return false;
    }
  }

  public upsertCollectionNode(innerPath: string, now: number): void {
    try {
      upsertNode(this.sql, innerPath, { isCollection: true, mtime: now, crtime: now, lockNull: false });
    } catch {
      // Metadata is best-effort; directory already created.
    }
  }

  public copyMeta(from: string, to: string, isCollection: boolean): void {
    try {
      const rows = this.sql.exec(`SELECT content_type, etag FROM dav_nodes WHERE path = ?`, from).toArray();
      const row = rows[0];
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO dav_nodes (path, is_collection, content_type, etag, mtime, crtime, lock_null) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(path) DO UPDATE SET is_collection=excluded.is_collection, content_type=excluded.content_type, etag=excluded.etag, mtime=excluded.mtime, lock_null=0`,
        to,
        isCollection ? 1 : 0,
        row?.['content_type'] ?? null,
        row?.['etag'] ?? null,
        now,
        now,
      );
      const props = this.sql.exec(`SELECT namespace_uri, local_name, prefix, value_xml FROM dav_props WHERE path = ?`, from).toArray();
      for (const p of props) {
        upsertDeadProperty(this.sql, to, {
          namespaceURI: String(p['namespace_uri'] ?? ''),
          localName: String(p['local_name'] ?? ''),
          prefix: p['prefix'] == null ? null : String(p['prefix']),
          valueXml: String(p['value_xml'] ?? ''),
        });
      }
      // Locks are NOT copied (per RFC 4918 §9.8).
    } catch {
      // Metadata copy is best-effort; file bytes already copied.
    }
  }

  public deleteCascade(innerPath: string): void {
    try {
      deleteNodeCascade(this.sql, innerPath);
    } catch {
      // Filesystem delete already succeeded; metadata GC retries on next write.
    }
  }

  public renameCascade(from: string, to: string): void {
    try {
      renameNodeCascade(this.sql, from, to);
    } catch {
      // Filesystem rename already succeeded; metadata repair is best-effort.
    }
  }
}

export { DavRepository };
export type {  NodeMeta };

export {type StatResult} from './davReadPolicy';