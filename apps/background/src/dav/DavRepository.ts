/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
import { deleteNodeCascade, getDeadProperties, renameNodeCascade, upsertNode } from '@durable-dav/dav-store';
import type { DirEntry as DofsChildEntry, DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';
import { normalizeLockDetails, type DavNodeInfo, type LockDetails } from '@durable-dav/webdav';
import { fsPathOf, hrefOf } from './DavContext';

// Repository over dofs + DO SQLite (why: the DO previously inlined every
// `dav_nodes/props/locks` statement, duplicating `dav-store/meta.ts` and
// swallowing failures per call site; centralizing here keeps SQL in one
// audited place and lets method handlers stay I/O-orchestration only).

interface StatResult {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

interface NodeMeta {
  contentType?: string;
  etag?: string;
  mtime?: number;
  crtime?: number;
}

class DavRepository {
  constructor(
    private readonly dofs: DofsFs,
    private readonly sql: DurableSqlStorage,
  ) {}

  public statInner(innerPath: string): StatResult {
    try {
      const st = this.dofs.stat(fsPathOf(innerPath));
      return { exists: true, isDirectory: st.isDirectory, size: st.size ?? 0, mtime: st.mtime ?? Date.now() };
    } catch {
      return { exists: false, isDirectory: false, size: 0, mtime: 0 };
    }
  }

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
   * prevent. Uses the same ancestor set as the guard.
   */
  private applicableLocks(innerPath: string, hrefBase: string): LockDetails[] {
    const ancestors: string[] = [];
    let cur = innerPath;
    for (;;) {
      ancestors.push(cur);
      if (cur === '' || ancestors.length >= 256) break;
      const slash = cur.lastIndexOf('/');
      cur = slash === -1 ? '' : cur.slice(0, slash);
    }
    const placeholders = ancestors.map(() => '?').join(', ');
    const rows = this.sql
      .exec(
        `SELECT path, token, scope, depth, owner, timeout, expires_at as expiresAt FROM dav_locks WHERE path IN (${placeholders}) AND expires_at > ?`,
        ...ancestors,
        Date.now(),
      )
      .toArray();
    return rows.flatMap((row) => {
      const token = String(row['token'] ?? '');
      if (!token) return [];
      const lockPath = String(row['path'] ?? '');
      const depth = row['depth'] === 'infinity' ? 'infinity' : '0';
      // A depth-0 ancestor lock does not reach this resource.
      if (depth !== 'infinity' && lockPath !== innerPath) return [];
      const normalized = normalizeLockDetails({
        token,
        owner: row['owner'] == null ? undefined : String(row['owner']),
        scope: row['scope'] === 'shared' ? 'shared' : 'exclusive',
        depth,
        timeout: String(row['timeout'] ?? ''),
        expiresAt: Number(row['expiresAt'] ?? 0),
        root: hrefOf(hrefBase, lockPath, true),
      });
      return normalized ? [normalized] : [];
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
        error: error instanceof Error ? (error.stack ?? error.message) : error,
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
      contentLanguage: undefined,
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
      contentLanguage: undefined,
      displayname: undefined,
      locks: [],
      deadProperties: [],
    };
  }

  public listChildren(innerPath: string): string[] {
    try {
      return this.dofs.listDir(fsPathOf(innerPath), {}).filter((n) => n !== '.' && n !== '..');
    } catch {
      return [];
    }
  }

  public listRecursive(innerPath: string): string[] {
    try {
      return this.dofs.listDir(fsPathOf(innerPath), { recursive: true }).filter((n) => n !== '.' && n !== '..');
    } catch {
      return [];
    }
  }

  /**
   * One page of direct children, as `{name, isDirectory}`.
   *
   * `listChildren` cannot back a pager: it materialises every name from one
   * unbounded scan and discards the `is_dir` column that scan already reads, so
   * ordering collections-first would cost a `statInner` per name. This carries
   * `isDirectory` out of the same query and stops at the page boundary, so a
   * caller hydrates `limit` children instead of all of them.
   *
   * Ordering is the server's, not the browser's — see `listDirPage`'s comment on
   * why the trailing binary `name` tiebreak is load-bearing. Failures return an
   * empty page (matching `listChildren`), which the caller cannot distinguish
   * from an empty directory; that is deliberate, since a pager that reported an
   * error would have to invent a total it does not have.
   */
  public listChildPage(innerPath: string, offset: number, limit: number): DofsChildEntry[] {
    try {
      return this.dofs.listDirPage(fsPathOf(innerPath), { offset, limit });
    } catch {
      return [];
    }
  }

  /**
   * Direct child count, for a pager's total and its last-page clamp.
   *
   * `COUNT(*)` over `idx_dofs_files_parent` rather than `listChildren().length`,
   * which would read every row to count it.
   */
  public countChildren(innerPath: string): number {
    try {
      return this.dofs.countChildren(fsPathOf(innerPath));
    } catch {
      return 0;
    }
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
      upsertNode(this.sql, innerPath, { isCollection: false, contentType, etag, mtime: now, crtime });
    } catch {
      // Metadata is best-effort; file bytes already persisted.
    }
  }

  public upsertCollectionNode(innerPath: string, now: number): void {
    try {
      upsertNode(this.sql, innerPath, { isCollection: true, mtime: now, crtime: now });
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
        `INSERT INTO dav_nodes (path, is_collection, content_type, etag, mtime, crtime) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET is_collection=excluded.is_collection, content_type=excluded.content_type, etag=excluded.etag, mtime=excluded.mtime`,
        to,
        isCollection ? 1 : 0,
        row?.['content_type'] ?? null,
        row?.['etag'] ?? null,
        now,
        now,
      );
      const props = this.sql.exec(`SELECT namespace_uri, local_name, prefix, value_xml FROM dav_props WHERE path = ?`, from).toArray();
      for (const p of props) {
        this.sql.exec(
          `INSERT INTO dav_props (path, namespace_uri, local_name, prefix, value_xml) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, namespace_uri, local_name) DO UPDATE SET prefix=excluded.prefix, value_xml=excluded.value_xml`,
          to,
          String(p['namespace_uri'] ?? ''),
          String(p['local_name'] ?? ''),
          p['prefix'] == null ? null : String(p['prefix']),
          String(p['value_xml'] ?? ''),
        );
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
export type { StatResult, NodeMeta };
