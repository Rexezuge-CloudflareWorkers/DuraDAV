/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
/* eslint-disable @typescript-eslint/require-await -- WebDAV LOCK handlers keep async for uniform dispatch. */
import type { DurableSqlStorage } from '@durable-dav/dav-store';
import { getLockDiscovery, normalizeLockToken, type LockDetails } from '@durable-dav/webdav';
import { hrefOf } from '../DavContext';
import type { DavBases } from '../DavContext';
import type { DavRepository } from '../DavRepository';
import {
  checkDescendantConflicts,
  checkScopeConflict,
  ensureLockableResource,
  findRefreshableLock,
  parseLockRequest,
  readLocks,
  rejectsInfinityDepth,
  resolveDepth,
  undoCreation,
  type LockDeps,
} from './lockPhases';

/**
 * UNLOCK needs strictly less than LOCK. The old shared interface forced the
 * caller to supply `writeEmptyFile: async () => false` and
 * `statIsDirectory: () => false` stubs that the function never read.
 */
interface UnlockDeps {
  repo: DavRepository;
  sql: DurableSqlStorage;
  unlink: (innerPath: string) => void;
}

/**
 * Write the lock row, or refresh the existing one by token.
 *
 * `null` on success, a `500` if the write fails — a LOCK that reported success
 * without a stored row would leave the client's token authorising nothing and
 * every later write unblocked.
 */
function writeLock(sql: DurableSqlStorage, existing: LockDetails | undefined, activePath: string, details: LockDetails): Response | null {
  try {
    if (existing) {
      sql.exec(
        `UPDATE dav_locks SET scope=?, depth=?, owner=?, timeout=?, expires_at=?, root=? WHERE token=?`,
        details.scope,
        details.depth,
        details.owner ?? null,
        details.timeout,
        details.expiresAt,
        details.root,
        details.token,
      );
    } else {
      sql.exec(
        `INSERT INTO dav_locks (token, path, scope, depth, owner, timeout, expires_at, root) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        details.token,
        activePath,
        details.scope,
        details.depth,
        details.owner ?? null,
        details.timeout,
        details.expiresAt,
        details.root,
      );
    }
    return null;
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * The §9.10 success body.
 *
 * Reports only the lock this request created or refreshed. The old shape echoed
 * *every* active lock on the path, so on a shared collection a client that had
 * just taken one lock received the write tokens of every other client — a direct
 * capability leak, since those tokens authorise DELETE/COPY/MOVE/PROPPATCH on
 * resources those clients believe protected. The full set belongs in a
 * `prop/lockdiscovery` PROPFIND (§15.8).
 */
function lockResponse(details: LockDetails, refreshed: boolean): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery([details])}</lockdiscovery></prop>`,
    {
      status: refreshed ? 200 : 201,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Lock-Token': `<urn:uuid:${details.token}>`,
      },
    },
  );
}

/**
 * RFC 4918 §9.10 LOCK.
 *
 * I/O orchestration only. Every rule it applies lives in `lockPhases`, one
 * function per rule, in the order the RFC reaches them — this was a 210-line
 * function that held all six jobs inline, which is why its §9.10.3 check had
 * drifted into running after the resource was created.
 */
async function handleLock(request: Request, innerPath: string, bases: DavBases, deps: LockDeps): Promise<Response> {
  const { locks, sql } = deps;
  const parsed = await parseLockRequest(request);
  if (parsed instanceof Response) return parsed;
  const { depthHeader, body, requestedScope, timeout, expiresAt } = parsed;

  const lockCheck = locks.assertLock(request, innerPath, {
    ignoreSharedOnTarget: body !== '' && requestedScope === 'shared',
  });
  if (lockCheck) return lockCheck;

  const descendantConflict = checkDescendantConflicts(request, innerPath, depthHeader, requestedScope, deps);
  if (descendantConflict) return descendantConflict;

  // Whether this request is the one that brings the resource into existence,
  // which decides whether a later rejection has something to undo. Captured
  // before `ensureLockableResource` runs; a refresh (`body === ''`) never creates.
  const resourceWasPresentAtEntry = deps.repo.statInner(innerPath).exists;

  let existing: LockDetails | undefined;
  let activePath = innerPath;
  if (body === '') {
    const found = findRefreshableLock(sql, innerPath, parsed.depthTokens);
    if (found && resourceWasPresentAtEntry) {
      existing = found.details;
      activePath = found.path;
    }
    // No pre-check when nothing was found: `assertLock` above already ran the
    // canonical query with proper token normalization. The block that used to sit
    // here compared normalized request tokens against *raw* stored tokens — the
    // exact mismatch `DavLockGuard` documents as having once made every locked
    // write 423.
  }

  const refusal = await ensureLockableResource(request, innerPath, body === '', deps);
  if (refusal) return refusal;

  const conflict = checkScopeConflict(sql, activePath, requestedScope, existing);
  if (conflict) return conflict;

  const targetIsCollection = deps.statIsDirectory(activePath);
  if (rejectsInfinityDepth(activePath, depthHeader, deps)) {
    if (!resourceWasPresentAtEntry) undoCreation(innerPath, deps);
    return new Response('Bad Request', { status: 400 });
  }

  const details: LockDetails = {
    token: existing?.token ?? crypto.randomUUID(),
    owner: parsed.owner ?? existing?.owner,
    scope: existing?.scope ?? requestedScope,
    depth: resolveDepth(existing, targetIsCollection, depthHeader),
    timeout,
    expiresAt,
    // Stored, so it survives a later PROPFIND — but `lockdiscovery` recomputes
    // its href from the current base rather than reading this column, so a
    // bucket that later switches href mode still advertises the right shape
    // there. Only this LOCK response body can echo a pre-switch value.
    root: hrefOf(bases.hrefBase, activePath, deps.statIsDirectory(activePath)),
  };
  return writeLock(sql, existing, activePath, details) ?? lockResponse(details, existing !== undefined);
}

async function handleUnlock(request: Request, innerPath: string, deps: UnlockDeps): Promise<Response> {
  const { repo, sql, unlink } = deps;
  const st = repo.statInner(innerPath);
  if (innerPath !== '' && !st.exists) return new Response('Not Found', { status: 404 });
  const lockToken = request.headers.get('Lock-Token');
  if (!lockToken) return new Response('Bad Request', { status: 400 });
  const normalized = normalizeLockToken(lockToken);

  try {
    // Resolve the exact stored token first, then delete by primary key. The
    // previous form used `token LIKE '%<normalized>%'` as a "compat" escape
    // hatch: `%` and `_` are LIKE metacharacters, so a `Lock-Token` of
    // `<urn:uuid: %>` built the pattern `%%%` and deleted *every* lock on the
    // path. The follow-up `DELETE FROM dav_locks WHERE token = ?` was also
    // dead in the normal case and wrong in the only case it could fire (a lock
    // legitimately held on an ancestor, which an UNLOCK scoped to a child must
    // not remove).
    const candidates = sql.exec(`SELECT token FROM dav_locks WHERE path = ?`, innerPath).toArray();
    const target = candidates
      .map((row) => String(row['token'] ?? ''))
      .find((token) => token !== '' && (token === normalized || normalizeLockToken(token) === normalized));
    if (target === undefined) return new Response('Conflict', { status: 409 });
    sql.exec(`DELETE FROM dav_locks WHERE token = ?`, target);
  } catch {
    return new Response('Conflict', { status: 409 });
  }

  // Clean up a lock-null resource — but only one that is *actually* a lock-null
  // resource. RFC 4918 §7.3: "A resource created with a LOCK … behaves the same
  // way as a resource created by a PUT request with an empty body" — so
  // "is it zero bytes" cannot tell the two apart, and using that as the test
  // deleted every empty file the moment its lock was released. The standard
  // client cycle is PUT(empty) -> LOCK -> UNLOCK (§6.2), so an ordinary empty
  // document was destroyed by the ordinary way of editing it.
  //
  // `dav_nodes.lock_null` is the discriminator: `VolumeTransfer.writeEmptyFile`
  // sets it, `upsertNode` clears it as soon as real content is written.
  // §7.3 says such a resource "SHOULD NOT disappear when its lock goes away";
  // the deprecated lock-null model of Appendix D says it should. Dropping the
  // row is the conforming choice and leaves an abandoned LOCK's file behind,
  // which a later LOCK or PUT overwrites harmlessly.
  if (innerPath !== '' && !st.isDirectory && st.size === 0) {
    const remaining = readLocks(sql, innerPath);
    if (remaining.length === 0 && repo.isLockNull(innerPath)) {
      try {
        unlink(innerPath);
        repo.deleteCascade(innerPath);
      } catch {
        // Best-effort cleanup; the UNLOCK itself already succeeded.
      }
    }
  }

  return new Response(null, { status: 204 });
}

export { handleLock, handleUnlock };
export type {  UnlockDeps };
export {type LockDeps} from './lockPhases';