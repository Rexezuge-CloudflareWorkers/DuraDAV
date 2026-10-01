/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
/* eslint-disable @typescript-eslint/require-await -- WebDAV LOCK handlers keep async for uniform dispatch. */
import type { DurableSqlStorage } from '@durable-dav/dav-store';
import {
  MAX_XML_BODY_BYTES,
  determineLockDepth,
  extractLockOwner,
  getLockDiscovery,
  getParentPath,
  getRequestLockTokens,
  normalizeLockDetails,
  normalizeLockToken,
  parseTimeout,
  readCappedText,
  type LockDetails,
} from '@durable-dav/webdav';
import { hrefOf } from '../DavContext';
import type { DavBases } from '../DavContext';
import type { DavLockGuard } from '../DavLockGuard';
import type { DavRepository } from '../DavRepository';

interface LockDeps {
  repo: DavRepository;
  locks: DavLockGuard;
  sql: DurableSqlStorage;
  writeEmptyFile: (innerPath: string) => Promise<boolean>;
  statIsDirectory: (innerPath: string) => boolean;
  /**
   * Remove a resource. Injected for the same reason as `writeEmptyFile` — LOCK
   * now has to undo its own creation when a later validation rejects the
   * request, and a rejected LOCK must leave nothing behind.
   */
  unlink: (innerPath: string) => void;
}

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

function readLocks(sql: DurableSqlStorage, innerPath: string): LockDetails[] {
  try {
    const rows = sql
      .exec(
        `SELECT token, scope, depth, owner, timeout, expires_at as expiresAt, root FROM dav_locks WHERE path = ? AND expires_at > ?`,
        innerPath,
        Date.now(),
      )
      .toArray();
    return rows.flatMap((r) => {
      const normalized = normalizeLockDetails({
        token: String(r['token'] ?? ''),
        owner: r['owner'] == null ? undefined : String(r['owner']),
        scope: r['scope'] === 'shared' ? 'shared' : 'exclusive',
        depth: r['depth'] === 'infinity' ? 'infinity' : '0',
        timeout: String(r['timeout'] ?? ''),
        expiresAt: Number(r['expiresAt'] ?? 0),
        root: String(r['root'] ?? '/'),
      });
      return normalized ? [normalized] : [];
    });
  } catch {
    return [];
  }
}

async function handleLock(request: Request, innerPath: string, bases: DavBases, deps: LockDeps): Promise<Response> {
  const { repo, locks, sql } = deps;
  const depthHeader = request.headers.get('Depth');
  if (depthHeader !== null && depthHeader !== '0' && depthHeader !== 'infinity') {
    return new Response('Bad Request', { status: 400 });
  }
  const { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
  const rawBody = await readCappedText(request, MAX_XML_BODY_BYTES);
  if (!rawBody.ok) return new Response('Payload Too Large', { status: 413 });
  const body = rawBody.text;
  const requestedScope = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
  if (body !== '' && !/<write\b/i.test(body)) return new Response('Bad Request', { status: 400 });
  const owner = extractLockOwner(body);
  const lockCheck = locks.assertLock(request, innerPath, {
    ignoreSharedOnTarget: body !== '' && requestedScope === 'shared',
  });
  if (lockCheck) return lockCheck;

  let existing: LockDetails | undefined;
  let activePath = innerPath;
  let resourceExists = repo.statInner(innerPath).exists;
  // Whether this request is the one that brings the resource into existence,
  // which decides whether a later rejection has something to undo. Captured
  // before `writeEmptyFile` runs; a refresh (`body === ''`) never creates.
  const resourceWasPresentAtEntry = resourceExists;
  // §7.4: "If a depth-infinity write LOCK request is issued to a collection
  // containing member URLs identifying resources that are currently locked in a
  // manner that conflicts with the new lock … the request MUST fail with a 423
  // (Locked) status code."
  //
  // Only the lock *root* was consulted before, and `assertLock` above walks
  // ancestors — so a lock held on `/a/b.txt` was invisible to `LOCK /a` with
  // `Depth: infinity`, and the INSERT succeeded. The result was two mutually
  // exclusive locks over one resource: the holder of the child lock was refused
  // on write by `DavLockGuard`, while `lockdiscovery` advertised only the
  // collection lock, so its client saw no reason for the 423. This is the
  // mirror image of the descendant scan `handleDelete` and `handleMove` run.
  //
  // Checked before the resource is created below, so a rejected request leaves
  // nothing behind.
  if (depthHeader === 'infinity' && repo.statInner(innerPath).isDirectory) {
    let descendants: string[];
    try {
      descendants = repo.requireRecursive(innerPath);
    } catch {
      // Cannot enumerate, so cannot prove there is no conflict. §7.4 makes this
      // a MUST-refuse; an unverifiable answer is not a pass.
      return new Response('Internal Server Error', { status: 500 });
    }
    const tokens = getRequestLockTokens(request);
    for (const name of descendants) {
      const childInner = repo.childInner(innerPath, name);
      const conflicting = locks
        .activeTokensForPath(childInner, tokens)
        .filter((token) => requestedScope === 'exclusive' || token.scope === 'exclusive');
      if (conflicting.length > 0) {
        return new Response('Locked', { status: 423 });
      }
    }
  }

  if (body === '') {
    const tokens = getRequestLockTokens(request);
    for (let cur = innerPath; ; cur = getParentPath(cur)) {
      try {
        const rows = sql
          .exec(
            `SELECT token, scope, depth, owner, timeout, expires_at as expiresAt, root FROM dav_locks WHERE path = ? AND expires_at > ?`,
            cur,
            Date.now(),
          )
          .toArray();
        const found = rows.find(
          (r) => tokens.includes(String(r['token'] ?? '')) && (cur === innerPath || String(r['depth']) === 'infinity'),
        );
        if (found) {
          const normalized = normalizeLockDetails({
            token: String(found['token']),
            owner: found['owner'] == null ? undefined : String(found['owner']),
            scope: found['scope'] === 'shared' ? 'shared' : 'exclusive',
            depth: found['depth'] === 'infinity' ? 'infinity' : '0',
            timeout: String(found['timeout'] ?? ''),
            expiresAt: Number(found['expiresAt'] ?? 0),
            root: String(found['root'] ?? '/'),
          });
          if (normalized && resourceExists) {
            existing = normalized;
            activePath = cur;
            break;
          }
        }
      } catch {
        // Best-effort refresh lookup; falls through to 423 handling below.
      }
      if (cur === '') break;
    }
    if (!existing && resourceExists) {
      // No extra pre-check here: `locks.assertLock` above already ran the
      // canonical query with proper token normalization. The removed block
      // compared normalized request tokens against *raw* stored tokens — the
      // exact mismatch `DavLockGuard` documents as having once made every
      // locked write 423.
    }
  }

  if (!resourceExists) {
    if (body === '') return new Response('Bad Request', { status: 400 });
    const parent = getParentPath(innerPath);
    if (parent !== '' && !repo.statInner(parent).isDirectory) return new Response('Conflict', { status: 409 });
    if (new URL(request.url).pathname.endsWith('/')) return new Response('Conflict', { status: 409 });
    const created = await deps.writeEmptyFile(innerPath);
    if (!created) return new Response('Conflict', { status: 409 });
    resourceExists = true;
  }
  if (!resourceExists) return new Response('Not Found', { status: 404 });

  const current = readLocks(sql, activePath);
  if (!existing) {
    if (requestedScope === 'exclusive' && current.length > 0) return new Response('Locked', { status: 423 });
    if (requestedScope === 'shared' && current.some((l) => l.scope === 'exclusive')) return new Response('Locked', { status: 423 });
  }

  // RFC 4918 §9.10.3: `Depth: infinity` MUST NOT be submitted on a
  // non-collection. Accepting it created an infinity-depth row on a file,
  // which the ancestor walk then treated as covering nonexistent children.
  //
  // This was checked *after* `writeEmptyFile` above, so the request created a
  // 0-byte file and then answered 400 — a failed request that left behind the
  // very resource it refused to lock, visible to the next PROPFIND and
  // unlocked. Order matters: validate, then create. The check stays (an
  // infinity-depth row on a file is meaningless), it just runs first.
  const targetIsCollection = deps.statIsDirectory(activePath);
  if (!targetIsCollection && depthHeader === 'infinity') {
    if (!resourceWasPresentAtEntry) {
      // Undo the creation this request performed, so a rejected LOCK leaves
      // nothing behind.
      try {
        deps.unlink(innerPath);
        repo.deleteCascade(innerPath);
      } catch {
        // Best-effort; the 400 below is the answer either way.
      }
    }
    return new Response('Bad Request', { status: 400 });
  }

  // RFC 4918 §9.10.2: a refresh "MUST NOT" change the lock's depth or scope.
  // The old guard only preserved depth when `Depth` was absent *and* the body
  // empty, so a refresh carrying an explicit `Depth: 0` silently downgraded an
  // existing `Depth: infinity` collection lock and released every descendant.
  const depth: '0' | 'infinity' = existing ? existing.depth : determineLockDepth(targetIsCollection, depthHeader);

  const details: LockDetails = {
    token: existing?.token ?? crypto.randomUUID(),
    owner: owner ?? existing?.owner,
    scope: existing?.scope ?? requestedScope,
    depth,
    timeout,
    expiresAt,
    // Stored, so it survives a later PROPFIND — but `lockdiscovery` recomputes
    // its href from the current base rather than reading this column, so a
    // bucket that later switches href mode still advertises the right shape
    // there. Only this LOCK response body can echo a pre-switch value.
    root: hrefOf(bases.hrefBase, activePath, deps.statIsDirectory(activePath)),
  };
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
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }
  return new Response(
    // Report only the lock this request created or refreshed. The old shape
    // echoed *every* active lock on the path, so on a shared collection a
    // client that had just taken one lock received the write tokens of every
    // other client — a direct capability leak, since those tokens authorise
    // DELETE/COPY/MOVE/PROPPATCH on resources those clients believe protected.
    // The full set belongs in a `prop/lockdiscovery` PROPFIND (§15.8).
    `<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery([details])}</lockdiscovery></prop>`,
    {
      status: existing ? 200 : 201,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Lock-Token': `<urn:uuid:${details.token}>`,
      },
    },
  );
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
export type { LockDeps, UnlockDeps };
