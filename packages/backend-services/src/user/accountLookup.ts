import { UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';

/**
 * A resolved account.
 *
 * `id` is the only value that should be used as an identity. `email` is the
 * address the account currently signs in with; `anchorEmail` is the immutable
 * value that `dav_volumes.owner_email` and `namespaces.user_email` store, and is
 * what a pre-0004 row can still be matched on.
 */
export interface ResolvedAccount {
  id: string;
  email: string;
  anchorEmail: string;
  username: string | null;
}

/**
 * The denormalized subset the `/user/*` routes and the permission path use.
 */
export type AccountSummary = Pick<ResolvedAccount, 'id' | 'email' | 'username'>;

export interface AccountLookupDeps {
  userDAO: () => Promise<UserDAO>;
  userEmailDAO: () => Promise<UserEmailDAO>;
}

/**
 * Shape every `users` read has, whether or not migration 0004 has run.
 */
type UserRowLike = { id?: string | null; email: string; current_email?: string | null; username: string | null } | null;

/**
 * Project a `users` row onto a `ResolvedAccount`.
 *
 * The `current_email ?? email` fallback is the 0004 rule in one place: before
 * the migration there is no `current_email` and the anchor *is* the login
 * address. It used to be written out at four call sites, each of which had to
 * remember that rule independently.
 *
 * Returns `null` for a row with no id — a pre-0004 row read without migration
 * 0004 applied, which is not an account this code can act on.
 */
function summarize(row: UserRowLike): ResolvedAccount | null {
  return row?.id ? { id: row.id, email: (row.current_email ?? row.email).toLowerCase(), anchorEmail: row.email, username: row.username ?? null } : null;
}

/**
 * Address -> account resolution.
 *
 * The registry (`user_emails`) is the only mapping that survives an address
 * change, so it is consulted first; the `users` lookups are the floor for
 * databases that have not run migration 0004, where the address *is* the anchor.
 *
 * Kept as free functions rather than methods so `UserIdentityService` and
 * `UserService` share one implementation instead of re-deriving the query.
 */
export async function resolveAccount(deps: AccountLookupDeps, email: string): Promise<ResolvedAccount | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const userDAO = await deps.userDAO();
  // A known address is authoritative: the registry says which account it belongs
  // to, and a *revoked* row (the account moved off this address) must not
  // resolve at all. Falling through to the legacy lookups in that case would let
  // a reassigned address keep authenticating the previous holder's account.
  const registered = await deps
    .userEmailDAO()
    .then((dao) => dao.get(normalized))
    // Registry absent on a database that has not run 0004.
    .catch(() => null);
  if (registered) {
    return registered.is_verified === 1 ? summarize(await userDAO.getById(registered.user_id).catch(() => null)) : null;
  }
  // No registry row at all. Safe to fall through: migration 0004 backfilled a
  // verified row for every anchor, so a row-less address is either new or on a
  // pre-0004 database, where the address *is* the anchor.
  const byCurrent = await userDAO.getByCurrentEmail(normalized).catch(() => null);
  const legacy = byCurrent ?? (await userDAO.getByEmail(normalized).catch(() => null));
  return summarize(legacy);
}

/**
 * Account id for an address, or null when unknown.
 */
export async function resolveUserId(deps: AccountLookupDeps, email: string): Promise<string | null> {
  const account = await resolveAccount(deps, email);
  return account?.id ?? null;
}

/**
 * Insert an account and claim its sign-in address.
 *
 * The anchor is the address itself whenever it is free, which keeps new rows
 * shaped like the pre-0004 ones. It falls back to an opaque anchor only when the
 * address is already held as another account's anchor — i.e. its previous holder
 * moved off it — so a released address is never permanently unusable.
 *
 * Returns null when the insert could not produce a *new* account holding this
 * address, which is the caller's signal to retry with a different anchor.
 *
 * The read-back is load-bearing, not defensive. `createUser` is
 * `ON CONFLICT(email) DO NOTHING`, so when the anchor is already taken the
 * insert is silently a no-op and the generated `id` belongs to nobody. Trusting
 * it would (a) re-point the address registry at a phantom account that resolves
 * to nothing, permanently stranding the address, and (b) on the opaque-anchor
 * retry, hand the caller an account whose address the registry refuses to
 * re-point because the phantom row already marked it verified. Re-reading the
 * anchor row and requiring *our* id to be the one there makes the no-op
 * detectable, so the retry gets a genuinely new account.
 */
export async function registerAccount(
  deps: AccountLookupDeps,
  loginEmail: string,
  anchor: string,
  now: number,
): Promise<ResolvedAccount | null> {
  const userDAO = await deps.userDAO();
  const id = UserDAO.newId();
  await userDAO.createUser({ id, anchor, loginEmail, now });
  const row = await userDAO.getByEmail(anchor);
  if (row?.id !== id) return null;
  // Claim the sign-in address *before* resolving, otherwise the fresh account is
  // invisible to the registry and registration looks like a failure. An address
  // already verified for another account is left alone by `register`, and the
  // resolve below then reports that account instead.
  await deps
    .userEmailDAO()
    .then((dao) => dao.register({ email: loginEmail, userId: id, isVerified: true, now }))
    .catch(() => {
      // Registry absent (database predating 0004): the anchor is the address.
    });
  return resolveAccount(deps, loginEmail);
}

export { summarize };
export type { UserRowLike };
