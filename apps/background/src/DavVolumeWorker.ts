/* eslint-disable @typescript-eslint/require-await -- Facade keeps async for DO RPC uniformity. */
import { DurableObject } from 'cloudflare:workers';
import { createDofsFs, setDofsDeviceSize, ensureDavSchema } from '@durable-dav/dav-store';
import type { DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';
import type { ReplicaStateRow } from '@durable-dav/dav-store';
import { DAV_CLASS, SUPPORT_METHODS } from '@durable-dav/webdav';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { DavRepository } from './dav/DavRepository';
import { DavLockGuard } from './dav/DavLockGuard';
import { fsPathOf, isValidInnerPath, resolveInnerPath, resolveDavBases } from './dav/DavContext';
import { VolumeTransfer } from './dav/VolumeTransfer';
import type { VolumeEntry } from './dav/VolumeTransfer';
import { VolumeReplicationRpc } from './dav/VolumeReplicationRpc';
import type { ReplicaApplyResult, ReplicaEntry, ReplicaOperation } from './dav/VolumeReplicationRpc';
import { handleGet } from './dav/methods/ReadMethods';
import { handleDelete, handleMkcol, handlePut } from './dav/methods/WriteMethods';
import { handlePropfind, handleProppatch } from './dav/methods/PropMethods';
import { handleCopy, handleMove } from './dav/methods/CopyMoveMethods';
import { handleLock, handleUnlock } from './dav/methods/LockMethods';

/**
 * Facade over one WebDAV volume.
 *
 * This class owns exactly three things: the error boundary, method dispatch,
 * and the wiring that connects `dav/methods/*` to `DavRepository` /
 * `DavLockGuard`. Everything else lives in a collaborator with one reason to
 * change:
 *
 * - `dav/methods/*` — one Command per RFC 4918 method family
 * - `DavRepository` — dofs + SQL reads
 * - `DavLockGuard` — lock preconditions
 * - `DavConditionalGuard` — RFC 7232 preconditions
 * - `VolumeTransfer` — the username-rename copy RPCs, which are not reachable
 *   from any `DAV:` method and used to sit inline here
 */
class DavVolumeWorker extends DurableObject<Env> {
  private readonly dofs: DofsFs;
  private readonly config: AppConfiguration;
  private sizeEnsured = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.dofs = createDofsFs(ctx, env);
    this.config = AppConfiguration.fromEnv(env);
    try {
      ensureDavSchema(ctx.storage.sql);
    } catch {
      // Schema bootstrap races on warm isolates; per-operation ensure below.
    }
  }

  /**
   * Apply the per-volume device quota, once per isolate.
   *
   * This used to run on every request — a SQL write on the hot path — and
   * swallowed every failure with a comment claiming the only error is ENOSPC.
   * `dofs.setDeviceSize` has no "already set" error, so any other failure left
   * the quota unenforced and invisible. Narrowed to the real error and logged.
   */
  private ensureSize(): void {
    if (this.sizeEnsured) return;
    try {
      setDofsDeviceSize(this.dofs, this.config.getDoDeviceBytes());
      this.sizeEnsured = true;
    } catch (error) {
      console.error('dofs device size could not be applied; volume quota may be unenforced', {
        error: error instanceof Error ? (error.stack ?? error.message) : error,
      });
    }
  }

  private sql(): DurableSqlStorage {
    const sql = this.ctx.storage.sql as unknown as DurableSqlStorage;
    try {
      ensureDavSchema(sql);
    } catch {
      // Per-op ensure is best-effort; statements surface real errors.
    }
    return sql;
  }

  private transfer(): VolumeTransfer {
    return new VolumeTransfer(this.dofs, this.sql());
  }

  private replication(): VolumeReplicationRpc {
    return new VolumeReplicationRpc(this.dofs, this.sql());
  }

  public override async fetch(request: Request): Promise<Response> {
    // Error boundary. Individual handlers have ad-hoc catch blocks with
    // inconsistent policies, and several body reads (`arrayBuffer`, `text`,
    // `clone`) reject on a truncated or aborted client stream — the front
    // forwards raw bodies with `duplex: 'half'`. Without this, one such
    // rejection escaped as a bare runtime 500 carrying no `DAV`/`Allow`
    // headers. Lock-lookup failures also surface here now that
    // `DavLockGuard` propagates instead of reporting "unlocked".
    try {
      this.ensureSize();
      return await this.dispatch(request);
    } catch (error) {
      console.error('DavVolumeWorker request failed', {
        method: request.method,
        url: request.url,
        error: error instanceof Error ? (error.stack ?? error.message) : error,
      });
      return new Response('Internal Server Error', {
        status: 500,
        headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // `X-Dav-Base` addresses the request; `X-Dav-Href-Prefix-Mode` only says
    // how hrefs should be anchored. See `DavBases`.
    const pathBase = request.headers.get('X-Dav-Base') ?? '';
    const bases = resolveDavBases(pathBase, request.headers.get('X-Dav-Href-Prefix-Mode'));
    const innerPath = resolveInnerPath(request, url, pathBase);
    if (innerPath === null) return new Response('Bad Request', { status: 400 });
    if (!isValidInnerPath(innerPath)) return new Response('Bad Request', { status: 400 });

    const sql = this.sql();
    const repo = new DavRepository(this.dofs, sql);
    const locks = new DavLockGuard(sql);

    // COPY and MOVE share the overwrite path: both delete an existing
    // destination through `handleDelete`, so COPY inherits its descendant-lock
    // scan. A dedicated COPY-only delete had reimplemented DELETE minus that
    // scan and could `rmdir --recursive` a collection with locked children.
    const deleteDestination = async (destInner: string, overwriteRequest: Request): Promise<Response | null> => {
      // `handleDelete` answers 204 on success, so `res.ok` alone is the whole
      // test. The previous `res.ok || res.status === 204` had a second arm that
      // could never decide anything (`Response.ok` is `status >= 200 && < 300`,
      // which already covers 204) — dead code that read as if the two branches
      // meant different things.
      const res = await handleDelete(overwriteRequest, destInner, repo, locks, this.dofs);
      return res.ok ? null : res;
    };

    switch (request.method) {
      case 'OPTIONS': {
        // RFC 4918 §9.1 + RFC 7231 §4.3.7: `OPTIONS *` is a server-wide
        // capability probe. `Content-Length: 0` and `MS-Author-Via` are
        // expected by Windows/Office Explorer's DAV discovery.
        return new Response(null, {
          status: 200,
          headers: {
            Allow: SUPPORT_METHODS.join(', '),
            DAV: DAV_CLASS,
            'MS-Author-Via': 'DAV',
            'Content-Length': '0',
          },
        });
      }
      case 'HEAD': {
        return handleGet(request, innerPath, bases, true, repo, this.dofs);
      }
      case 'GET': {
        return handleGet(request, innerPath, bases, false, repo, this.dofs);
      }
      case 'PUT': {
        return handlePut(request, innerPath, repo, locks, this.dofs, this.config.getMaxFileBytes());
      }
      case 'DELETE': {
        return handleDelete(request, innerPath, repo, locks, this.dofs);
      }
      case 'MKCOL': {
        return handleMkcol(request, innerPath, repo, locks, this.dofs);
      }
      case 'PROPFIND': {
        return handlePropfind(request, innerPath, bases, repo);
      }
      case 'PROPPATCH': {
        return handleProppatch(request, innerPath, bases, repo, locks, sql);
      }
      case 'COPY': {
        return handleCopy(request, innerPath, bases, repo, locks, this.dofs, deleteDestination);
      }
      case 'MOVE': {
        return handleMove(request, innerPath, bases, repo, locks, this.dofs, deleteDestination);
      }
      case 'LOCK': {
        return handleLock(request, innerPath, bases, {
          repo,
          locks,
          sql,
          writeEmptyFile: (p) => this.transfer().writeEmptyFile(p),
          statIsDirectory: (p) => repo.statInner(p).isDirectory,
          unlink: (p) => this.dofs.unlink(fsPathOf(p)),
        });
      }
      case 'UNLOCK': {
        return handleUnlock(request, innerPath, { repo, sql, unlink: (p) => this.dofs.unlink(fsPathOf(p)) });
      }
      default: {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS },
        });
      }
    }
  }

  // --- Username-rename transfer RPCs (see `VolumeTransfer`) -----------------

  public async listVolumeEntries(): Promise<VolumeEntry[]> {
    this.ensureSize();
    return this.transfer().listEntries();
  }

  public async readVolumeFile(path: string): Promise<{ dataBase64: string; contentType: string | null } | null> {
    this.ensureSize();
    return this.transfer().readFile(path);
  }

  public async writeVolumeEntry(entry: {
    path: string;
    isCollection: boolean;
    contentType?: string | null;
    etag?: string | null;
    dataBase64?: string | null;
    props?: import('@durable-dav/webdav').DeadProperty[];
  }): Promise<void> {
    this.ensureSize();
    await this.transfer().writeEntry(entry);
  }

  /**
  Destroy all volume content. Idempotent.

  `dav_replica_state` is cleared alongside the rest: leaving it would let a
  volume later recreated at the same path inherit a base describing a tree that
  no longer exists, and the first sync pass would then propagate deletions the
  owner never made.
  */
  public async deleteVolume(): Promise<void> {
    try {
      this.dofs.rmdir('/', { recursive: true });
    } catch {
      // Missing root is fine on repeated deletes.
    }
    try {
      const sql = this.sql();
      sql.exec(`DELETE FROM dav_nodes`);
      sql.exec(`DELETE FROM dav_props`);
      sql.exec(`DELETE FROM dav_locks`);
      sql.exec(`DELETE FROM dav_replica_state`);
    } catch {
      // Filesystem delete already succeeded; metadata GC retries on next op.
    }
  }

  // --- Scheduled replication RPCs (see `VolumeReplicationRpc`) ---------------

  /**
   * Direct children of a collection, for the sync planner.
   *
   * Reachable only from the cron runner and the owner-scoped `POST .../run`
   * route — never from a `DAV:` method, and deliberately with no `fetch` path:
   * the DO is reachable through the front door, so a byte-stream entrypoint
   * would have to carry authentication of its own to be safe.
   */
  public async listReplicaChildren(path: string): Promise<ReplicaEntry[]> {
    this.ensureSize();
    return this.replication().listChildren(path);
  }

  public async loadReplicaStateRows(replicationId: string): Promise<ReplicaStateRow[]> {
    this.ensureSize();
    return this.replication().loadState(replicationId);
  }

  public async applyReplicaOperations(replicationId: string, operations: ReplicaOperation[]): Promise<ReplicaApplyResult> {
    this.ensureSize();
    return this.replication().apply(replicationId, operations);
  }

  /**
   * Drop the recorded base for one replication.
   *
   * Called when the replication is deleted. A re-created replication against the
   * same target must not inherit the old base: it would report thousands of
   * unchanged files and propagate every deletion the old one had recorded.
   */
  public async forgetReplication(replicationId: string): Promise<void> {
    this.ensureSize();
    this.replication().forget(replicationId);
  }

  /**
  File bytes for a push, or for the opt-in ambiguity hash.
  */
  public async readReplicaStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    this.ensureSize();
    return this.replication().readStream(path);
  }

  public async readReplicaBytes(path: string): Promise<Uint8Array | null> {
    this.ensureSize();
    return this.replication().readBytes(path);
  }
}

export { DavVolumeWorker };
