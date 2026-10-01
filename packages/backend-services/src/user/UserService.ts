import { DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { UserRow } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { BadRequestError, NotFoundError } from '@durable-dav/backend-errors';
import { isReservedNamespaceName, isValidUsername } from '@durable-dav/shared/constants';
import { isMissingSchemaError, TimestampUtil } from '@durable-dav/shared/utils';
import { cascadeOwnerVolumes } from './volumeRenameCascade';
import { registerAccount, resolveAccount } from './accountLookup';
import type { AccountLookupDeps, AccountSummary, ResolvedAccount } from './accountLookup';
import { deriveUsernameCandidate, namespaceBelongsTo, userBelongsTo } from './usernameRules';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps extends Partial<AccountLookupDeps> {
  namespaceDAO?: () => Promise<NamespaceDAO>;
  volumeDAO?: () => Promise<DavVolumeDAO>;
}

/**
 * Outcome of taking a handle in the `namespaces` registry.
 *
 * - `claimedFresh` — we created the claim, so a later step that fails must
 *   release it. `false` means the row was already ours and must be left alone.
 * - `legacyNamespaces` — there is no registry at all (a database predating the
 *   `namespaces` table), so `users.username` is the only authority.
 */
interface HandleClaim {
  claimedFresh: boolean;
  legacyNamespaces?: boolean;
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
      const userDAO = await this.deps.userDAO();
      await userDAO.ensureUsername(account.id, handle, now);
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

  /**
   * Look a handle up.
   *
   * Propagates a database failure. It used to `catch` and return `null`, which
   * made `GET /users/:username` report "no such user" during a D1 outage — and
   * that endpoint is how a client checks whether a handle is available, so a
   * blip would have looked like a definitive "taken, pick another" answer.
   * A `null` return now means exactly one thing: no such row.
   */
  public async getByUsername(username: string): Promise<UserRow | null> {
    const dao = await this.deps.userDAO();
    return dao.getByUsernameCi(username.toLowerCase());
  }

  /**
   * Take the new handle in the `namespaces` registry.
   *
   * Split out of `renameUsername` because the outcome is a three-way decision
   * that the caller has to act on, and encoding it as three mutable flags made
   * the interaction between them discoverable only by tracing. The flags were:
   * `claimedFresh` (we own the claim, so a later failure must release it),
   * `namespaceClaimed` (the name is ours to use), and `legacyNamespaces` (there
   * is no registry, so `users.username` is authoritative).
   *
   * Claim-first ordering is what narrows the rename TOCTOU: the name is claimed
   * *before* `users` is mutated, so a concurrent claimer wins with a clean abort
   * instead of leaving `users.username` renamed with no namespace behind it.
   */
  private async claimHandle(nsDao: NamespaceDAO, handleCi: string, account: ResolvedAccount, now: number): Promise<HandleClaim> {
    try {
      await nsDao.claim({ usernameCi: handleCi, kind: 'user', userEmail: account.anchorEmail, userId: account.id, now });
      return { claimedFresh: true };
    } catch (error) {
      // Claim race, or the registry is unavailable.
      //
      // The old `catch (inner)` inferred "there is no `namespaces` table at all"
      // from `get`/`isTaken` having thrown. That inference is unsound: both
      // throw on a transient D1 failure too, and none of those mean the table
      // is absent. The rename then committed `users.username` with no matching
      // namespace row — the half-applied state this method's claim-first
      // ordering exists to prevent.
      //
      // So a genuine schema absence still degrades (that is what the pre-0004
      // `users.username` fallback is for), and anything else rethrows.
      try {
        const row = await nsDao.get(handleCi);
        if (row && namespaceBelongsTo(row, account)) return { claimedFresh: false };
        if (await nsDao.isTaken(handleCi)) throw new BadRequestError('Username is already taken');
      } catch (inner) {
        // A `BadRequestError` is our own verdict ("taken") and must propagate.
        if (inner instanceof BadRequestError) throw inner;
        // Absent registry only. A failed read is not that, and must not be
        // allowed to read as it.
        if (!isMissingSchemaError(inner)) throw inner;
        return { claimedFresh: false, legacyNamespaces: true };
      }
      throw error instanceof Error ? error : new BadRequestError('Username is already taken');
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
    const claim = await this.claimHandle(nsDao, handleCi, account, now);
    const oldCi = account.username?.toLowerCase();
    const userDAO = await this.deps.userDAO();
    // `handleCi`, not `handle`: the DAO stores lowercase, and returning `handle`
    // here would hand the caller back a value the database does not hold. Every
    // downstream comparison is lowercase, so this is the same string the row
    // really has.
    try {
      await userDAO.setUsername(account.id, handleCi, now);
    } catch (error) {
      // Only release a claim *we* took. Releasing one we merely found already
      // belonging to us would free a name the account still owns.
      if (claim.claimedFresh) {
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
      await cascadeOwnerVolumes({ volumeDAO: this.deps.volumeDAO }, { oldOwnerCi: oldCi, newOwner: handleCi, now }).catch(() => {
        // ignore
      });
    }
    return { id: account.id, email: account.email, username: handleCi };
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
    let namespaceUnreadable = false;
    try {
      const row = await nsDao.get(handleCi);
      if (row) {
        if (row.kind === 'user' && namespaceBelongsTo(row, account)) selfOwned = true;
        else otherOwned = true;
      }
    } catch (error) {
      // Only a missing registry is tolerable here, and only because the pre-0004
      // `users.username` fallback exists. A *failed read* is an outage, and the
      // old bare `catch` reported it as "no claim exists" — which let a rename
      // commit on top of a claim this code could not see, the exact
      // half-applied state the claim-first ordering above exists to prevent.
      // Fail closed instead: treat an unverifiable registry as taken.
      namespaceUnreadable = !isMissingSchemaError(error);
    }
    if (otherOwned) return true;
    // Unreadable registry: answer "taken", so `renameUsername` refuses. Same
    // posture as an unreadable claim, for the same reason.
    if (namespaceUnreadable) return true;
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
