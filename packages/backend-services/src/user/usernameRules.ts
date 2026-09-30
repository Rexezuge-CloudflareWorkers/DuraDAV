import type { NamespaceRow, UserRow } from '@durable-dav/backend-data/dao';
import { USERNAME_MAX_LENGTH, isValidUsername } from '@durable-dav/shared/constants';
import type { ResolvedAccount } from './accountLookup';

/**
 * Username derivation and the two ownership predicates.
 *
 * Split out of `UserService` so that file is about orchestration rather than
 * string munging: the service is long enough that the helpers at the top were
 * pushing it past the god-file threshold, and all three are pure functions with
 * no dependency on the service's DAOs — they are the same shape as
 * `accountLookup` and `volumeRenameCascade`, which were extracted earlier for
 * the same reason.
 */

/**
 * A readable handle to propose for an account, derived from its anchor address.
 *
 * Sanitise, collapse runs of `-`, trim them, then try progressively weaker
 * fallbacks: the sanitised form, the alphanumeric characters alone, and finally
 * a fixed `user`. The last step matters because an opaque
 * `anchor-…@users.invalid` account still needs *some* handle, and returning an
 * empty one would leave the account unable to ever own a bucket.
 */
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

export { deriveUsernameCandidate, namespaceBelongsTo, userBelongsTo };
