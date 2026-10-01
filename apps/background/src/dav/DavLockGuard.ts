/* eslint-disable @typescript-eslint/no-base-to-string -- DO SQLite rows are primitives (TEXT/INTEGER); Record<string, unknown> trips the object-stringification guard. */
import type { DurableSqlStorage } from '@durable-dav/dav-store';
import { getParentPath, getRequestLockTokens, hasAlwaysFalseIfCondition, normalizeLockToken } from '@durable-dav/webdav';
import { MAX_PATH_DEPTH } from './DavContext';

// Lock precondition guard (why: every mutating method duplicated the
// ancestor-walk + token-match logic; one Policy object keeps RFC 4918 §9.10
// semantics in a single testable place).
class DavLockGuard {
  constructor(private readonly sql: DurableSqlStorage) {}

  /**
   * Ancestor chain of `innerPath`, nearest first, root last.
   *
   * Bounded so a pathological deep path cannot drive an unbounded SQL walk,
   * and the bound is `MAX_PATH_DEPTH` — the same limit `isValidInnerPath`
   * accepts, imported rather than re-typed as a literal. The previous `256`
   * literal was one segment short: a path of exactly 256 segments filled the
   * cap with depths 256→1 and stopped *before* pushing the volume root `''`,
   * so a `Depth: infinity` lock on the root silently stopped applying one level
   * below maximum depth. `DavRepository.applicableLocks` had the identical cap,
   * which is why `lockdiscovery` agreed with the guard and the bug was
   * invisible from either side.
   */
  private static ancestorsOf(innerPath: string): string[] {
    const out: string[] = [];
    let cur = innerPath;
    for (;;) {
      out.push(cur);
      // `cur === ''` is the normal exit; the cap only bounds a pathological
      // path, and it must leave room for the root.
      if (cur === '' || out.length > MAX_PATH_DEPTH) break;
      cur = getParentPath(cur);
    }
    return out;
  }

  /**
   * All unexpired locks on `innerPath` or any ancestor, as
   * `{ path, token, scope, depth }`. A single query rather than one per
   * ancestor level: the old shape issued depth-many round trips through the
   * storage layer on every write.
   *
   * Throws if the lookup fails. A failed lookup must never be reported as
   * "unlocked" — that silently downgraded Class 2 to Class 1.
   */
  private locksAffecting(innerPath: string): Array<{ path: string; token: string; scope: string; depth: string }> {
    const ancestors = DavLockGuard.ancestorsOf(innerPath);
    const placeholders = ancestors.map(() => '?').join(', ');
    const rows = this.sql
      .exec(`SELECT path, token, scope, depth FROM dav_locks WHERE path IN (${placeholders}) AND expires_at > ?`, ...ancestors, Date.now())
      .toArray();
    return rows.map((row) => ({
      path: String(row['path'] ?? ''),
      token: String(row['token'] ?? ''),
      scope: String(row['scope'] ?? ''),
      depth: String(row['depth'] ?? '0'),
    }));
  }

  public assertLock(request: Request, innerPath: string, opts: { ignoreSharedOnTarget?: boolean } = {}): Response | null {
    if (hasAlwaysFalseIfCondition(request)) return new Response('Precondition Failed', { status: 412 });
    // Normalize both sides (why: `If`/`Lock-Token` headers arrive as
    // `<opaquelocktoken:…>`/`urn:uuid:…` while `dav_locks.token` stores the
    // raw value; raw comparison never matched and every locked write 423'd).
    const tokens = new Set(getRequestLockTokens(request).map((t) => normalizeLockToken(t)));

    const blocking = this.locksAffecting(innerPath).filter((lock) => {
      // A depth-0 lock only covers its own node; an ancestor's depth-0 lock
      // does not reach descendants.
      if (lock.depth !== 'infinity' && lock.path !== innerPath) return false;
      const sharedOnTarget = lock.path === innerPath && opts.ignoreSharedOnTarget === true && lock.scope === 'shared';
      return !sharedOnTarget && !tokens.has(normalizeLockToken(lock.token));
    });

    return blocking.length > 0 ? new Response('Locked', { status: 423 }) : null;
  }

  /**
   * Lock tokens on `innerPath` held by *other* clients, as
   * `{ token, scope }`. Used by recursive DELETE and MOVE to refuse removing or
   * relocating locked descendants (RFC 4918 §9.6.1 / §9.9.4 / §10.4), and by
   * a depth-infinity LOCK to detect a conflicting lock already held below the
   * collection (§7.4) — which needs the scope, since a shared lock only
   * conflicts with an exclusive request.
   *
   * Deliberately returns the scope: a bare token list cannot answer "is any
   * descendant locked in a manner that conflicts", which is a different question
   * from "is anything locked at all". Throws on lookup failure — an empty
   * result must mean "genuinely unlocked".
   */
  public activeTokensForPath(innerPath: string, tokens: string[]): { token: string; scope: string }[] {
    const normalized = new Set(tokens.map((t) => normalizeLockToken(t)));
    return this.locksAffecting(innerPath)
      .filter((lock) => lock.path === innerPath)
      .map((lock) => ({ token: lock.token, scope: lock.scope }))
      .filter((lock) => lock.token !== '' && !normalized.has(normalizeLockToken(lock.token)));
  }
}

export { DavLockGuard };
