import { UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { BadRequestError, DatabaseError } from '@durable-dav/backend-errors';
import { isValidEmailFormat } from '@durable-dav/shared/utils';
import { TimestampUtil } from '@durable-dav/shared/utils';
import { resolveAccount, summarize } from '../user/accountLookup';
import type { AccountLookupDeps, ResolvedAccount } from '../user/accountLookup';

interface UserIdentityEnv {
  DB: D1Queryable;
}

/**
 * Injected DAO factories. All optional: each defaults to a real DAO over the
 * same D1 binding, so tests override only what they need.
 */
type UserIdentityDeps = Partial<AccountLookupDeps>;

/**
 * The account behind an address.
 *
 * Resolution itself lives in `accountLookup` (one implementation, shared with
 * `UserService`); this adds the per-scope memoization and the address-change
 * operations. The instance is one per request scope, so the ownership and
 * permission paths — which resolve the same caller several times each — cost one
 * query rather than one per comparison.
 */
class UserIdentityService {
  private readonly deps: Required<AccountLookupDeps>;
  private readonly byEmail = new Map<string, ResolvedAccount | null>();

  constructor(
    env: UserIdentityEnv,
    deps: UserIdentityDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      userEmailDAO: () => Promise.resolve(new UserEmailDAO(env.DB)),
      ...deps,
    };
  }

  /**
   * Resolve a sign-in address to its account, or null when unknown.
   *
   * Only a verified address resolves. A revoked address (changed away from) is
   * retained so pre-change rows stay attributable, but it must never
   * authenticate, otherwise a reassigned address would inherit the previous
   * holder's account.
   */
  public async resolveAccount(email: string): Promise<ResolvedAccount | null> {
    const key = email.trim().toLowerCase();
    if (!isValidEmailFormat(key)) return null;
    if (this.byEmail.has(key)) return this.byEmail.get(key) ?? null;
    const resolved = await this.load(key);
    this.byEmail.set(key, resolved);
    return resolved;
  }

  /**
   * Account id for a sign-in address, or null when unknown.
   */
  public async resolveUserId(email: string): Promise<string | null> {
    const account = await this.resolveAccount(email);
    return account?.id ?? null;
  }

  /**
   * Account behind a stable key. The inverse direction, for a caller that
   * already holds one (a volume owner) and needs the current address.
   */
  public async resolveUserById(userId: string): Promise<ResolvedAccount | null> {
    const userDAO = await this.deps.userDAO();
    const row = await userDAO.getById(userId).catch((error: unknown) => {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(`Failed to resolve account: ${error instanceof Error ? error.message : String(error)}`);
    });
    return summarize(row);
  }

  private async load(email: string): Promise<ResolvedAccount | null> {
    return resolveAccount(this.deps, email).catch((error: unknown) => {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(`Failed to load identity: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Every address known for an account, verified ones first.
   */
  public async listAddresses(userId: string): Promise<Array<{ email: string; isVerified: boolean }>> {
    const emailDAO = await this.deps.userEmailDAO();
    const rows = await emailDAO.listByUserId(userId);
    return rows.map((row) => ({ email: row.email, isVerified: row.is_verified === 1 }));
  }

  /**
   * Point an account at a new sign-in address.
   *
   * The account id, the frozen anchor, and every id-keyed row are untouched:
   * only which address authenticates the account moves. The previous address is
   * revoked rather than deleted, so rows written before the change still resolve
   * to this account, and it is released for a later legitimate holder.
   *
   * Rejects an address already verified for another account. That check is the
   * whole reason this is not simply an `UPDATE`: Cloudflare Access is the only
   * authenticator, so an unverified self-service change would let anyone claim
   * an address and inherit its buckets.
   *
   * No route exposes this yet — proof of control for the new address (a confirm
   * step performed while authenticated as that address) has to land first. The
   * ops path is `scripts/change-email.ts`.
   */
  public async setPrimaryEmail(
    userId: string,
    newEmail: string,
    now = TimestampUtil.getCurrentUnixTimestampInSeconds(),
  ): Promise<ResolvedAccount> {
    const email = newEmail.trim().toLowerCase();
    if (!isValidEmailFormat(email)) throw new BadRequestError('Invalid email address');
    const userDAO = await this.deps.userDAO();
    const emailDAO = await this.deps.userEmailDAO();
    const row = await userDAO.getById(userId);
    if (!row?.id) throw new BadRequestError('User not found');
    const current = (row.current_email ?? row.email).toLowerCase();
    if (current === email) {
      return { id: row.id, email, anchorEmail: row.email, username: row.username ?? null };
    }
    const holder = await emailDAO.resolveVerified(email);
    if (holder && holder.user_id !== row.id) throw new BadRequestError('Email is already in use');
    // Order is load-bearing, and it is the one `scripts/change-email.ts` already
    // gets right: claim first, move `current_email` second, revoke third.
    //
    // This ran register -> revoke -> setCurrentEmail, which inverts it. If
    // `setCurrentEmail` then failed — most plausibly on the UNIQUE constraint
    // `idx_users_current_email`, which another account can hold — every
    // address was already revoked, so nothing authenticated while
    // `users.current_email` still named the old one. Not a permanent lockout
    // (login resolves through the registry, and the new address is verified),
    // but `summarize()` reported the old address and `getByCurrentEmail` no
    // longer matched, for every subsequent request.
    await emailDAO.register({ email, userId: row.id, isVerified: true, now });
    await userDAO.setCurrentEmail(row.id, email, now);
    // Revoke every other verified address, so only the new one authenticates.
    await emailDAO.revokeAllVerified(row.id, email);
    this.byEmail.delete(current);
    this.byEmail.set(email, { id: row.id, email, anchorEmail: row.email, username: row.username ?? null });
    return { id: row.id, email, anchorEmail: row.email, username: row.username ?? null };
  }

  /**
   * Ops/migration path: attach an address that has already been proven, without
   * making it the sign-in address.
   */
  public async linkVerifiedEmail(userId: string, email: string, now = TimestampUtil.getCurrentUnixTimestampInSeconds()): Promise<void> {
    const address = email.trim().toLowerCase();
    if (!isValidEmailFormat(address)) throw new BadRequestError('Invalid email address');
    const emailDAO = await this.deps.userEmailDAO();
    const outcome = await emailDAO.register({ email: address, userId, isVerified: true, now });
    if (outcome === 'already-claimed') throw new BadRequestError('Email is already in use');
  }
}

export { UserIdentityService };
export type { UserIdentityDeps, UserIdentityEnv };
