import { DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { NamespaceRow, UserRow } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { BadRequestError, NotFoundError } from '@durable-dav/backend-errors';
import { USERNAME_MAX_LENGTH, isReservedNamespaceName, isValidUsername } from '@durable-dav/shared/constants';
import { TimestampUtil } from '@durable-dav/shared/utils';
import { cascadeOwnerVolumes } from './volumeRenameCascade';
import { registerAccount, resolveAccount } from './accountLookup';
import type { AccountLookupDeps, AccountSummary, ResolvedAccount } from './accountLookup';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps extends Partial<AccountLookupDeps> {
  namespaceDAO?: () => Promise<NamespaceDAO>;
  volumeDAO?: () => Promise<DavVolumeDAO>;
}

function deriveUsernameCandidate(email: string): string {
  const prefix = email.split('@', 1)[0].toLowerCase();
  let sanitized = '';
  for (const ch of prefix) {
    sanitized += ch === '-' || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ? ch : '-';
  }
  sanitized = sanitized.replaceAll(/-{2,}/g, '-');
  let start = 0;
  while (start < sanitized.length && sanitized[start] === '-') start += 1;
  let end = sanitized.length;
  while (end > start && sanitized[end - 1] === '-') end -= 1;
  sanitized = sanitized.slice(start, end);
  if (isValidUsername(sanitized)) return sanitized;
  let alnum = '';
  for (const ch of sanitized) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) alnum += ch;
  }
  return alnum.length > 0 ? alnum.slice(0, USERNAME_MAX_LENGTH) : 'user';
}

/**
 * Does a namespace claim belong to this account?
 *
 * `user_id` is the identity once migration 0004 has run. The fallback compares
 * the row's frozen anchor address, which by construction never changes — so both
 * branches mean the same thing, on a pre-0004 row and on a 0004 row whose address
 * matched no account.
 */
function namespaceBelongsTo(row: NamespaceRow, account: ResolvedAccount): boolean {
  return row.user_id ? row.user_id === account.id : row.user_email?.toLowerCase() === account.anchorEmail.toLowerCase();
}

/**
 * Does a `users` row belong to this account? Same rule as
 * `namespaceBelongsTo`, for the pre-0004 `users` shape.
 */
function userBelongsTo(row: UserRow, account: ResolvedAccount): boolean {
  return row.id ? row.id === account.id : row.email.toLowerCase() === account.anchorEmail.toLowerCase();
}

class UserService {
  private readonly deps: Required<UserServiceDeps>;

  constructor(
    private readonly env: UserServiceEnv,
    deps: UserServiceDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      userEmailDAO: () => Promise.resolve(new UserEmailDAO(env.DB)),
      namespaceDAO: () => Promise.resolve(new NamespaceDAO(env.DB)),
      volumeDAO: () => Promise.resolve(new DavVolumeDAO(env.DB)),
      ...deps,
    };
  }

  public static validateUsername(username: string): void {
    if (!isValidUsername(username)) {
      throw new BadRequestError('Invalid username');
    }
    if (isReservedNamespaceName(username)) {
      throw new BadRequestError('Username is reserved');
    }
  }

  /**
   * Resolve the authenticated address to an account, registering one if the
   * address is unknown.
   *
   * Resolution goes through the address registry rather than `users.email`, so a
   * person who changes their address keeps the same account — and therefore
   * their buckets, handle, and credentials — instead of acquiring a second,
   * empty one. An address already verified for an account always resolves to
   * that account, so registration can never fork an identity.
   *
   * A resolution failure propagates: the caller has an authenticated address but
   * no account, and there is nothing safe to authorize. The username bootstrap
   * below it *is* best-effort, because a missing handle must not prevent sign-in.
   */
  public async upsertUser(email: string): Promise<AccountSummary> {
    const normalized = email.toLowerCase();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    let account = await resolveAccount(this.deps, normalized);
    if (!account) {
      // Prefer the address as the frozen anchor (what pre-0004 rows look like),
      // so new rows stay readable by ops. Fall back to an opaque anchor only
      // when the address is still held as another account's anchor — its
      // previous holder moved off it — so a released address stays claimable by
      // a later holder instead of being stranded forever.
      account = await registerAccount(this.deps, normalized, normalized, now);
      if (!account) account = await registerAccount(this.deps, normalized, UserDAO.newAnchor(), now);
    }
    if (!account) throw new NotFoundError('Could not resolve or provision an account for this address');
    await this.bootstrapUsername(account, now);
    return { id: account.id, email: account.email, username: account.username };
  }

  /**
   * Give an account a handle if it has none. Existing rows keep theirs.
   *
   * The candidate is derived from the *anchor* address rather than the current
   * one so that a user who signs in first with an opaque `anchor-…@users.invalid`
   * still gets a readable handle.
   */
  private async bootstrapUsername(account: ResolvedAccount, now: number): Promise<void> {
    if (account.username) return;
    try {
      const base = deriveUsernameCandidate(account.anchorEmail);
      const handle = await this.findFreeUsername(base);
      await this.deps.userDAO().then((dao) => dao.ensureUsername(account.id, handle, now));
      const ns = await this.deps.namespaceDAO();
      await ns.claimIgnore({ usernameCi: handle.toLowerCase(), kind: 'user', userEmail: account.anchorEmail, userId: account.id, now });
    } catch {
      // Never fail authentication because of profile bootstrap. On a database
      // without `namespaces` the `users.username` column is authoritative.
    }
  }

  private async findFreeUsername(base: string): Promise<string> {
    const dao = await this.deps.userDAO();
    const nsDao = await this.deps.namespaceDAO();
    let candidate = base;
    for (let attempt = 0; attempt < 50; attempt++) {
      const ci = candidate.toLowerCase();
      let taken = isReservedNamespaceName(ci);
      try {
        taken ||= await nsDao.isTaken(ci);
      } catch {
        // `namespaces` absent — keep the reserved-derived value.
      }
      if (!taken) {
        const userMatch = await dao.getByUsernameCi(ci).catch(() => null);
        taken = Boolean(userMatch);
      }
      if (!taken) return candidate;
      candidate = `${base}-${attempt + 1}`;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  public async getProfileByEmail(email: string): Promise<AccountSummary> {
    const account = await resolveAccount(this.deps, email.toLowerCase());
    if (!account) throw new NotFoundError('User not found');
    return { id: account.id, email: account.email, username: account.username };
  }

  public async getByUsername(username: string): Promise<UserRow | null> {
    const dao = await this.deps.userDAO();
    try {
      return await dao.getByUsernameCi(username.toLowerCase());
    } catch {
      return null;
    }
  }

  public async renameUsername(email: string, newUsername: string): Promise<AccountSummary> {
    const handle = newUsername.trim();
    UserService.validateUsername(handle);
    const handleCi = handle.toLowerCase();
    const account = await resolveAccount(this.deps, email.toLowerCase());
    if (!account) throw new NotFoundError('User not found');
    if (account.username?.toLowerCase() === handleCi) {
      return { id: account.id, email: account.email, username: account.username };
    }
    const nsDao = await this.deps.namespaceDAO();
    if (await this.isHandleTaken(nsDao, handleCi, account)) throw new BadRequestError('Username is already taken');
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    // Claim-first ordering narrows the rename TOCTOU: claim the new name
    // before mutating `users`, so a concurrent claimer wins with a clean
    // abort instead of leaving `users.username` renamed without a namespace.
    // If the subsequent update fails, best-effort release the new claim.
    let claimedFresh = false;
    let namespaceClaimed = false;
    let legacyNamespaces = false;
    try {
      await nsDao.claim({ usernameCi: handleCi, kind: 'user', userEmail: account.anchorEmail, userId: account.id, now });
      namespaceClaimed = true;
      claimedFresh = true;
    } catch (error) {
      // Claim race: if the existing claim belongs to self (rename-back after a
      // failure), treat as success. Otherwise report taken cleanly. Legacy DBs
      // without a `namespaces` table fall back to `users.username` as
      // authoritative (claim/isTaken both throw there).
      try {
        const row = await nsDao.get(handleCi).catch(() => null);
        if (row && namespaceBelongsTo(row, account)) {
          namespaceClaimed = true;
          claimedFresh = false;
        } else if (await nsDao.isTaken(handleCi)) {
          throw new BadRequestError('Username is already taken');
        }
      } catch (inner) {
        if (inner instanceof BadRequestError) throw inner;
        // isTaken itself threw → namespaces table missing → legacy path.
        legacyNamespaces = true;
      }
      if (!legacyNamespaces && !namespaceClaimed) {
        throw error instanceof Error ? error : new BadRequestError('Username is already taken');
      }
    }
    const oldCi = account.username?.toLowerCase();
    try {
      await this.deps.userDAO().then((dao) => dao.setUsername(account.id, handle, now));
    } catch (error) {
      if (claimedFresh) {
        await nsDao.release(handleCi).catch(() => {
          // ignore rollback failure
        });
      }
      throw error;
    }
    // Old names stay reserved (no immediate release) so a concurrent attacker
    // cannot hijack the freed handle in the window between D1 rename and
    // propagation. Renamed-away handles remain taken for other accounts, but the
    // owning account may reclaim them.
    if (oldCi) {
      await cascadeOwnerVolumes({ volumeDAO: this.deps.volumeDAO }, { oldOwnerCi: oldCi, newOwner: handle, now }).catch(() => {
        // ignore
      });
    }
    return { id: account.id, email: account.email, username: handle };
  }

  /**
   * Is `handleCi` unavailable to this account?
   *
   * Both registries are consulted because either can be ahead of the other: a
   * `namespaces` row can outlive a `users.username` change (and is the authority
   * once claimed), while a `users.username` value is the only handle on a
   * database with no `namespaces` table at all.
   */
  private async isHandleTaken(nsDao: NamespaceDAO, handleCi: string, account: ResolvedAccount): Promise<boolean> {
    let otherOwned = false;
    let selfOwned = false;
    try {
      const row = await nsDao.get(handleCi);
      if (row) {
        if (row.kind === 'user' && namespaceBelongsTo(row, account)) selfOwned = true;
        else otherOwned = true;
      }
    } catch {
      // get failed — fall through to isTaken below.
    }
    if (otherOwned) return true;
    if (!selfOwned && (await nsDao.isTaken(handleCi).catch(() => false))) return true;
    const userMatch = await this.deps
      .userDAO()
      .then((dao) => dao.getByUsernameCi(handleCi))
      .catch(() => null);
    return userMatch !== null && !userBelongsTo(userMatch, account);
  }
}

export { UserService };
export type { UserServiceDeps, UserServiceEnv };
