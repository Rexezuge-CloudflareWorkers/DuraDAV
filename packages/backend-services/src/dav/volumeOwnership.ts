import type { DavVolumeRow } from '@durable-dav/backend-data/dao';

/**
 * A resolved caller, as the ownership paths see one.
 *
 * `userId` is the stable account key (migration 0004). `email` is the address
 * the caller signed in with, which is also the only thing available on a
 * database that has not been migrated — hence the nullable id.
 */
export interface ViewerIdentity {
  userId: string | null;
  email: string;
}

/**
 * Does this caller own this volume?
 *
 * Migration 0004 moved ownership off the email address and onto the account key,
 * because `owner_email` is a *frozen anchor*: it is the `users(email)` foreign
 * key target, so it never changes and cannot identify a caller who has moved to
 * a new address. Comparing it against a live sign-in address therefore locked
 * every user out of their own buckets the moment their address changed.
 *
 * The two branches answer the same question on differently-shaped rows:
 *  - `owner_user_id` present (post-backfill, or written by a 0004-aware create):
 *    the account key decides. This is the authoritative path.
 *  - absent: the row predates 0004, or its owner address matched no account when
 *    the backfill ran. The anchor comparison is the only thing left, and it is
 *    exact because the anchor is immutable.
 *
 * A row with a present `owner_user_id` never falls back to the address — a
 * caller whose id is unknown must be refused, not matched on a string that may
 * since have been re-registered by a different account.
 */
export function isVolumeOwner(viewer: ViewerIdentity | null, volume: DavVolumeRow): boolean {
  if (!viewer) return false;
  return volume.owner_user_id ? viewer.userId !== null && viewer.userId === volume.owner_user_id : viewer.email.toLowerCase() === volume.owner_email.toLowerCase();
}
