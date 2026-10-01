import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

/**
 * The stored form of a handle: lowercase.
 *
 * Every username read (`getByUsernameCi`) and every username write goes through
 * this, so the two can never disagree about case. That agreement is not
 * cosmetic: `users.username` has no `COLLATE NOCASE` (SQLite defaults to
 * BINARY), so a stored `Alice2` is a *different value* from `alice2` and a
 * lookup that lowercases its parameter would never find it. Normalising at the
 * write points rather than relying on each caller means a future caller cannot
 * reintroduce an unfindable handle by forgetting.
 */
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * `users` rows.
 *
 * `id` is the stable account key, added by migration 0004. `email` is the
 * *anchor*: an immutable primary-key value that `dav_volumes.owner_email` and
 * `namespaces.user_email` point at, so history stays resolvable across an
 * address change. Accounts created before 0004 have their real address there;
 * accounts created after it prefer it too (so new rows keep the shape ops
 * already reads), falling back to an opaque anchor when the address is still
 * held by a previous holder — see `UserDAO.newAnchor`.
 *
 * `current_email` is the address the account signs in with and the one the API
 * reports. It is NULL only on databases that have not run 0004.
 */
export interface UserRow {
  id?: string | null;
  /**
   * The frozen anchor address. Never updated — it is a `dav_volumes` foreign key
   * target, and rewriting it would cascade the user's buckets out of the
   * database. Read `current_email` for the sign-in address.
   */
  email: string;
  /**
   * Mutable sign-in address. Absent on a pre-0004 database, where `email` *is*
   * the sign-in address; read it as `current_email ?? email`.
   */
  current_email?: string | null;
  created_at: number;
  username: string | null;
  updated_at: number | null;
}

class UserDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  /**
   * Opaque anchor for an account whose login address is already held as another
   * account's anchor.
   *
   * It must be globally unique and must never be a real address: `email` is the
   * primary key every legacy `*_email` foreign key resolves against, so an
   * address parked here could never be re-registered by a different person
   * after its original account moved off it. `.invalid` is reserved by RFC 2606
   * and can never be delivered to, so it can never authenticate either.
   */
  public static newAnchor(): string {
    return `anchor-${this.randomHex()}@users.invalid`;
  }

  public static newId(): string {
    return `usr_${this.randomHex()}`;
  }

  private static randomHex(): string {
    return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Create an account, stamped with the 0004 identity columns.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` with **no conflict target**, deliberately.
   * `users` carries two unique constraints — the `email` primary key and
   * `idx_users_current_email` — and SQLite applies `DO NOTHING` only to the
   * constraints a named target covers. Naming `email` therefore left a
   * `current_email` collision as a raised error, which `registerAccount` cannot
   * tell from a transient D1 failure: it propagated instead of returning `null`,
   * so the opaque-anchor retry never ran and every `/user/*` request answered
   * 500. The read-back in `registerAccount` is what distinguishes "inserted" from
   * "silently a no-op", so an untargeted clause loses nothing.
   */
  public async createUser(input: { id?: string | null; anchor: string; loginEmail: string; now: number }): Promise<void> {
    // Both addresses are lowercased at the single write point rather than by
    // each caller. `users.email` is the primary key every legacy `*_email` FK
    // resolves against, so a mixed-case anchor would let one person be two
    // accounts — and `ON CONFLICT(email)` would not catch the second.
    const anchor = input.anchor.toLowerCase();
    const loginEmail = input.loginEmail.toLowerCase();
    await this.withRetry(
      () =>
        this.database
          .prepare('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .bind(anchor, input.now, input.id ?? UserDAO.newId(), loginEmail)
          .run(),
      'create user',
    );
  }

  /**
   * Pre-0004 insert path, kept for callers that only hold an address. The anchor
   * is the address itself, matching the shape of rows already in the database.
   */
  public async upsertUser(email: string, now: number): Promise<void> {
    // Lowercased here rather than relying on the caller: `users.email` is the
    // primary key every legacy `*_email` FK resolves against, so two casings of
    // one address would be two accounts — and `ON CONFLICT(email)` would not
    // catch the second.
    const normalized = email.toLowerCase();
    await this.createUser({ anchor: normalized, loginEmail: normalized, now });
  }

  /**
   * @param idOrEmail The stable account key, or an anchor address as the
   *   pre-0004 fallback. `WHERE id = ? OR email = ?` cannot use either index as
   *   a seek, so this stays off the hot path; login resolves through
   *   `UserIdentityService` instead.
   */
  public async ensureUsername(idOrEmail: string, username: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE users SET username = COALESCE(username, ?), updated_at = COALESCE(updated_at, ?) WHERE id = ? OR email = ?')
          .bind(normalizeUsername(username), now, idOrEmail, idOrEmail)
          .run(),
      'ensure username',
    );
  }

  /**
  @param idOrEmail The stable account key, or an anchor address.
   */
  public async setUsername(idOrEmail: string, username: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ? OR email = ?')
          .bind(normalizeUsername(username), now, idOrEmail, idOrEmail)
          .run(),
      'set username',
    );
  }

  /**
   * Anchor lookup — used for legacy `*_email` values and cascade resolution.
   *
   * This is *not* a login lookup: an account that has changed its address is not
   * findable here by its new one. It is the pre-0004 floor and the attribution
   * read.
   */
  public async getByEmail(email: string): Promise<UserRow | null> {
    // Lowercase the *parameter*: every writer stores the anchor lowercased, so
    // `lower(email) = lower(?)` matched identically while making the primary
    // key unusable.
    return this.database.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<UserRow>();
  }

  /**
  The account behind a stable key. Null on a pre-0004 database.
  */
  public async getById(id: string): Promise<UserRow | null> {
    return this.database.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(id).first<UserRow>();
  }

  /**
  The account currently signing in with this address. 0004-only.
  */
  public async getByCurrentEmail(email: string): Promise<UserRow | null> {
    return this.database.prepare('SELECT * FROM users WHERE current_email = ? LIMIT 1').bind(email.toLowerCase()).first<UserRow>();
  }

  /**
   * Move an account's sign-in address.
   *
   * The anchor `email` is deliberately untouched: it is what every legacy
   * `*_email` column and foreign key resolves against.
   */
  public async setCurrentEmail(id: string, email: string, now: number): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?').bind(email.toLowerCase(), now, id).run(),
      'set current email',
    );
  }

  /**
 * Lookup by handle.
 *
 * The parameter is lowercased, never the column — `lower(username)` makes the
 * index unusable. That is only sound because every writer stores lowercase, and
 * `renameUsername` is the one place that could break it: `USERNAME_PATTERN`
 * carries the `/i` flag, so `PATCH {"username":"Alice2"}` validated and
 * `setUsername` stored `Alice2` verbatim against a BINARY-collated column. Every
 * later lookup compared `'alice2' = 'Alice2'` and missed, so the handle became
 * permanently unfindable — `GET /users/alice2` 404'd, the dashboard link broke,
 * and re-submitting the same name hit the case-insensitive equality short-circuit
 * and reported success while changing nothing. The normalisation now lives in
 * `setUsername`/`ensureUsername` below, so it cannot be forgotten by a caller.
 *
 * (Note: there is no index on `users.username` in any migration, so this is a
 * full scan either way — the parameter-side lowercase is kept because it is the
 * rule that makes the *semantics* correct, not the performance.)
 */
public async getByUsernameCi(usernameCi: string): Promise<UserRow | null> {
    return this.database.prepare('SELECT * FROM users WHERE username = ? LIMIT 1').bind(usernameCi.toLowerCase()).first<UserRow>();
  }
}

export { UserDAO };
