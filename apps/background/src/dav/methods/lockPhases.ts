/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
import type { DurableSqlStorage } from '@durable-dav/dav-store';
import {
  MAX_XML_BODY_BYTES,
  determineLockDepth,
  extractLockOwner,
  getParentPath,
  getRequestLockTokens,
  parseTimeout,
  readCappedText,
  type LockDetails,
} from '@durable-dav/webdav';
import type { DavLockGuard } from '../DavLockGuard';
import { DavLockGuard as LockGuard } from '../DavLockGuard';
import { LOCK_COLUMNS, lockDetailsFromRow, storedLockRoot } from '../lockRows';
import type { DavRepository } from '../DavRepository';

/**
 * The validation phases of RFC 4918 §9.10, one function per phase.
 *
 * `handleLock` was a 210-line function doing six jobs — header validation, XML
 * parse, lock assert, §7.4 descendant scan, refresh lookup, depth negotiation,
 * upsert, response — with the reasoning for each interleaved in the flow. The
 * rules were therefore only auditable by reading all six at once, in order, and
 * one of them (§9.10.3, validate-before-create) had been in the wrong order for
 * exactly that reason.
 *
 * They are here rather than inline because the *order* is the property worth
 * stating: every check in this file runs before `handleLock` creates anything,
 * except the one that cannot (§9.10.3 needs to know what the path is, and its
 * undo is explicit).
 */
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
 * A `Depth` header that has already passed validation, so every later consumer
 * takes it as a precondition met rather than a raw header.
 */
type LockDepth = '0' | 'infinity' | null;

/**
 * What the client asked for, before anything is created or written.
 */
interface LockRequest {
  depthHeader: LockDepth;
  /**
   * The capped request body. `''` is a refresh (§9.10.1), not a new lock.
   */
  body: string;
  requestedScope: 'shared' | 'exclusive';
  /**
   * Absent when the body carried no `<owner>`.
   */
  owner: string | undefined;
  /**
   * Tokens from `If`/`Lock-Token` (§9.10.1). Captured here so the refresh lookup
   * is answered from parsed request state rather than re-reading headers.
   */
  depthTokens: string[];
  timeout: string;
  expiresAt: number;
}

/**
 * Validate headers and parse the lockinfo body.
 *
 * Every rejection here happens before the resource is created, which is the
 * ordering `rejectsInfinityDepth` depends on: a LOCK that answers `400` must
 * leave nothing behind, and the one check that used to run after
 * `writeEmptyFile` had created a 0-byte file and then refused it.
 */
async function parseLockRequest(request: Request): Promise<LockRequest | Response> {
  const rawDepth = request.headers.get('Depth');
  if (rawDepth !== null && rawDepth !== '0' && rawDepth !== 'infinity') {
    return new Response('Bad Request', { status: 400 });
  }
  const depthHeader = rawDepth;
  const { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
  const rawBody = await readCappedText(request, MAX_XML_BODY_BYTES);
  if (!rawBody.ok) return new Response('Payload Too Large', { status: 413 });
  const body = rawBody.text;
  const requestedScope = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
  if (body !== '' && !/<write\b/i.test(body)) return new Response('Bad Request', { status: 400 });
  return {
    depthHeader,
    body,
    requestedScope,
    owner: extractLockOwner(body),
    depthTokens: getRequestLockTokens(request),
    timeout,
    expiresAt,
  };
}

/**
 * Locks held on exactly `innerPath`, mapped through the shared row reader.
 *
 * Degrades to `[]` on a failed read, unlike `DavLockGuard`, which fails closed.
 * That asymmetry is intentional: this is a *decision* input ("is the target
 * already exclusively locked?"), where reporting a lookup failure as locked
 * would 423 every LOCK that followed, and the guard has already made the
 * authoritative check that does fail closed.
 */
function readLocks(sql: DurableSqlStorage, innerPath: string): LockDetails[] {
  try {
    const rows = sql.exec(`SELECT ${LOCK_COLUMNS} FROM dav_locks WHERE path = ? AND expires_at > ?`, innerPath, Date.now()).toArray();
    return rows.flatMap((row) => {
      const details = lockDetailsFromRow(row, storedLockRoot(row));
      return details ? [details] : [];
    });
  } catch {
    return [];
  }
}

/**
 * §9.10.1 refresh: the lock `tokens` already hold on `innerPath` or an ancestor.
 *
 * Walks the guard's ancestor set — so a refresh of a child finds the
 * `Depth: infinity` lock on its collection, and stops applying at the same depth
 * the guard stops enforcing at. This was a third independent answer to "which
 * ancestors", with no depth cap of its own.
 *
 * `null` on a failed read at any level: an unresolvable refresh falls through to
 * the conflict handling rather than inventing a lock. Only this lookup degrades.
 */
function findRefreshableLock(sql: DurableSqlStorage, innerPath: string, tokens: string[]): { path: string; details: LockDetails } | null {
  for (const cur of LockGuard.ancestorsOf(innerPath)) {
    try {
      const rows = sql.exec(`SELECT ${LOCK_COLUMNS} FROM dav_locks WHERE path = ? AND expires_at > ?`, cur, Date.now()).toArray();
      const found = rows.find((row) => tokens.includes(String(row['token'] ?? '')) && (cur === innerPath || row['depth'] === 'infinity'));
      const details = found ? lockDetailsFromRow(found, storedLockRoot(found)) : null;
      if (details) return { path: cur, details };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * §7.4 descendant scan: refuse a depth-infinity LOCK whose collection already
 * contains a conflicting lock.
 *
 * `null` means no conflict. Only consulted for a collection — a `Depth: infinity`
 * request against a file is refused by the §9.10.3 check instead.
 *
 * Only the lock *root* used to be consulted, so a lock held on `/a/b.txt` was
 * invisible to `LOCK /a` with `Depth: infinity` and the INSERT succeeded: two
 * mutually exclusive locks over one resource, the holder of the child refused on
 * write by the guard while `lockdiscovery` advertised only the collection lock.
 * This is the mirror image of the descendant scan `handleDelete` and `handleMove`
 * run.
 */
function checkDescendantConflicts(request: Request, innerPath: string, depthHeader: LockDepth, requestedScope: 'shared' | 'exclusive', deps: LockDeps): Response | null {
  if (depthHeader !== 'infinity' || !deps.repo.statInner(innerPath).isDirectory) return null;
  let descendants: string[];
  try {
    descendants = deps.repo.requireRecursive(innerPath);
  } catch {
    // Cannot enumerate, so cannot prove there is no conflict. §7.4 makes this
    // a MUST-refuse; an unverifiable answer is not a pass.
    return new Response('Internal Server Error', { status: 500 });
  }
  const tokens = getRequestLockTokens(request);
  for (const name of descendants) {
    const childInner = deps.repo.childInner(innerPath, name);
    const conflicting = deps.locks
      .activeTokensForPath(childInner, tokens)
      .filter((token) => requestedScope === 'exclusive' || token.scope === 'exclusive');
    if (conflicting.length > 0) return new Response('Locked', { status: 423 });
  }
  return null;
}

/**
 * Make sure there is something at `innerPath` to take a lock on.
 *
 * A LOCK may create the resource (§7.3: a lock-null resource, which behaves as a
 * zero-byte `PUT`), and a *refresh* may not — a refresh for a path that is not
 * there is a `400`, because there is no lock to refresh.
 *
 * The three `409`s are refusals of a creation that cannot succeed: a missing
 * parent, a request URL naming a collection, or a write that failed.
 */
async function ensureLockableResource(request: Request, innerPath: string, isRefresh: boolean, deps: LockDeps): Promise<Response | null> {
  if (deps.repo.statInner(innerPath).exists) return null;
  if (isRefresh) return new Response('Bad Request', { status: 400 });
  const parent = getParentPath(innerPath);
  if (parent !== '' && !deps.repo.statInner(parent).isDirectory) return new Response('Conflict', { status: 409 });
  if (new URL(request.url).pathname.endsWith('/')) return new Response('Conflict', { status: 409 });
  return (await deps.writeEmptyFile(innerPath)) ? null : new Response('Conflict', { status: 409 });
}

/**
 * Undo a LOCK's own creation of `innerPath`.
 *
 * Best-effort by design: the `400` is the answer either way, and a failed cleanup
 * must not turn a clean rejection into a `500`. The alternative was leaving a
 * 0-byte file that the next PROPFIND lists as an unlocked resource the client
 * never asked for.
 */
function undoCreation(innerPath: string, deps: LockDeps): void {
  try {
    deps.unlink(innerPath);
    deps.repo.deleteCascade(innerPath);
  } catch {
    // Best-effort.
  }
}

/**
 * §9.10.3: `Depth: infinity` MUST NOT be submitted on a non-collection.
 *
 * Accepting it created an infinity-depth row on a file, which the ancestor walk
 * then treated as covering nonexistent children.
 *
 * This cannot be validated before creation — it needs to know whether the target
 * *is* a collection — which is why it runs late and undoes its own creation
 * rather than the others running late. Order matters: validate, then create.
 */
function rejectsInfinityDepth(activePath: string, depthHeader: LockDepth, deps: LockDeps): boolean {
  return depthHeader === 'infinity' && !deps.statIsDirectory(activePath);
}

/**
 * §9.10.2: a refresh "MUST NOT" change the lock's depth or scope.
 *
 * The old guard only preserved depth when `Depth` was absent *and* the body
 * empty, so a refresh carrying an explicit `Depth: 0` silently downgraded an
 * existing `Depth: infinity` collection lock and released every descendant.
 */
function resolveDepth(existing: LockDetails | undefined, targetIsCollection: boolean, depthHeader: LockDepth): '0' | 'infinity' {
  return existing ? existing.depth : determineLockDepth(targetIsCollection, depthHeader);
}

/**
 * §7.7 conflict rules for a lock this request is *taking*: an exclusive request
 * must find nothing, a shared request must find no exclusive lock.
 *
 * A refresh is exempt — re-refreshing the lock you already hold necessarily finds
 * it, which is not a conflict.
 */
function checkScopeConflict(sql: DurableSqlStorage, activePath: string, requestedScope: 'shared' | 'exclusive', existing: LockDetails | undefined): Response | null {
  if (existing) return null;
  const current = readLocks(sql, activePath);
  const blocked = requestedScope === 'exclusive' ? current.length > 0 : current.some((lock) => lock.scope === 'exclusive');
  return blocked ? new Response('Locked', { status: 423 }) : null;
}

export {
  checkDescendantConflicts,
  checkScopeConflict,
  ensureLockableResource,
  findRefreshableLock,
  parseLockRequest,
  readLocks,
  rejectsInfinityDepth,
  resolveDepth,
  undoCreation,
};
export type { LockDeps, LockDepth, LockRequest };