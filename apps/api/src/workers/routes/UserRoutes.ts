import { Tokens } from '@durable-dav/backend-services/composition';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { invalidateVolumeCaches, invalidateVolumeListCache } from './DavReadCache';
import { moveVolumeDosForRename, splitFull } from './VolumeMove';
import { requireUser, withErrorMapping } from './VolumeScopedRoute';

type App = ApiApp;

/**
 * How many owned volumes the pre-rename snapshot will collect.
 *
 * Above `MAX_VOLUMES_PER_USER` (default 100) so a raise in that env var can
 * never silently truncate the list and strand the tail. A user beyond the
 * snapshot is a misconfiguration; renaming with a partial move is worse.
 */
const RENAME_SNAPSHOT_LIMIT = 1000;

/**
`GET /user/me` — the caller's own account.

Reports the *current* sign-in address, not the frozen anchor: `users.email` is
immutable and may be an opaque `anchor-…@users.invalid` for an account created
against a reused address, so echoing it would show the user a login they do not
have. The address the request authenticated with is the honest answer.
*/
async function handleMe(c: ApiContext): Promise<Response> {
  const identity = requireUser(c);
  if (identity instanceof Response) return identity;
  const { email } = identity;
  const scope = BaseRoute.getScope(c);
  // No `.catch(() => null)`: a D1 outage was reported as `username: null`,
  // which the SPA reads as "you still need to pick a handle" and pushes the
  // user into the rename flow during an incident.
  const profile = await scope.get(Tokens.UserService).getProfileByEmail(email);
  return c.json({ email, username: profile.username ?? null });
}

/**
Owned volume ids+names, snapshotted *before* the D1 rename.

Keyed on the account id so the snapshot is complete for a user who has changed
their sign-in address since the buckets were created.

Propagates on failure. An empty result means "this account owns no volumes",
which is a legitimate reason to skip the DO move — but a *failed read* used to
be reported the same way, and the rename then committed in D1 with every volume
left behind in the old Durable Object.
*/
async function snapshotOwnedVolumes(c: ApiContext, userId: string | null, email: string): Promise<Array<{ id: string; name: string }>> {
  const dao = await BaseRoute.getScope(c).get(Tokens.DavVolumeDAO)();
  const rows = userId ? await dao.listByOwnerUserId(userId, RENAME_SNAPSHOT_LIMIT) : await dao.listByOwnerEmail(email, RENAME_SNAPSHOT_LIMIT);
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    if (!row.id || !row.name || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, name: row.name });
  }
  return out;
}

/**
Drop every cached read for the volumes a rename moved.
*/
async function invalidateRenamedCaches(
  c: ApiContext,
  cacheKey: string,
  moves: ReadonlyArray<{ oldFull: string; newFull: string }>,
): Promise<void> {
  try {
    const cache = BaseRoute.getScope(c).get(Tokens.KvCache);
    await invalidateVolumeListCache(cache, cacheKey);
    for (const move of moves) {
      const { owner: oldOwner, volume: oldVolume } = splitFull(move.oldFull);
      const { owner: newOwner, volume: newVolume } = splitFull(move.newFull);
      await invalidateVolumeCaches(cache, oldOwner, oldVolume);
      await invalidateVolumeCaches(cache, newOwner, newVolume);
    }
  } catch {
    // Best-effort; D1 and the DOs are already consistent.
  }
}

/**
 * `PATCH /user/me/username`.
 *
 * Fail-closed DO move: volume files + dead props are copied old→new and the old
 * isolate is purged only after the copy verifies. On copy failure the D1 rename
 * is rolled back so the request surfaces 500 rather than an empty volume.
 *
 * **Everything is read before the D1 rename commits, and any read failure aborts
 * the request.** The previous shape read the profile with `.catch(() => null)`
 * and the volume snapshot with `catch { return [] }`, so a transient D1 error
 * made `handleChanged` false, the DO move never ran, and the caller received
 * `200 { username: <new> }` while every bucket's bytes stayed in the *old*
 * Durable Object. That is unrecoverable without a second rename, and it is the
 * exact anti-pattern `handleMe` documents at the top of this file. A rename
 * that cannot be completed end to end must not be half-applied.
 */
async function handleRenameUsername(c: ApiContext): Promise<Response> {
  const identity = requireUser(c);
  if (identity instanceof Response) return identity;
  const { email, userId } = identity;
  const read = await BaseRoute.readJson<{ username?: string }>(c);
  const unreadable = BaseRoute.rejectUnreadableBody(c, read);
  if (unreadable) return unreadable;
  const { body } = read;
  if (!body.username || typeof body.username !== 'string') return BaseRoute.jsonError(c, 'username is required', 400);

  const scope = BaseRoute.getScope(c);
  const userService = scope.get(Tokens.UserService);
  // Not swallowed. An unreachable value here means we cannot know which volumes
  // have to move, and proceeding is the data-loss case.
  const before = await userService.getProfileByEmail(email);
  const beforeUsername = before.username;
  if (typeof beforeUsername !== 'string' || beforeUsername.length === 0) {
    return BaseRoute.jsonError(c, 'No username is provisioned for this account', 409);
  }
  const newUsername = body.username;
  const handleChanged = beforeUsername.toLowerCase() !== newUsername.toLowerCase();

  // Snapshot BEFORE the D1 rename: afterwards `owner_ci` already reads the new
  // handle, so a post-rename filter by the old name matches nothing and the DO
  // move would silently never run. Also not swallowed — see above.
  const snapshot = handleChanged ? await snapshotOwnedVolumes(c, userId, email) : [];
  const moves = snapshot.map((volume) => ({
    id: volume.id,
    name: volume.name,
    oldFull: `${beforeUsername}/${volume.name}`,
    newFull: `${newUsername}/${volume.name}`,
  }));

  await userService.renameUsername(email, newUsername);

  if (handleChanged) {
    if (moves.length > 0) {
      try {
        await moveVolumeDosForRename(c.env, moves);
      } catch (moveError) {
        console.error('volume DO move failed during rename; rolling the D1 handle back', {
          from: beforeUsername,
          to: newUsername,
          volumes: moves.length,
          error: moveError instanceof Error ? (moveError.stack ?? moveError.message) : moveError,
        });
        // The rollback is the last thing standing between a caller who sees
        // `200 { username: <new> }` and a caller whose buckets are stranded in
        // the old DO, so its own failure is logged rather than discarded and
        // the message says which state the caller is actually in.
        const rolledBack = await userService
          .renameUsername(email, beforeUsername)
          .then(() => true)
          .catch((rollbackError: unknown) => {
            console.error('username rollback failed; the handle is renamed but its volumes are NOT moved', {
              from: beforeUsername,
              to: newUsername,
              error: rollbackError instanceof Error ? (rollbackError.stack ?? rollbackError.message) : rollbackError,
            });
            return false;
          });
        return BaseRoute.jsonError(
          c,
          rolledBack ? 'Failed to move volume data' : 'Failed to move volume data and roll back the rename; the username was changed',
          500,
        );
      }
    }
    // Invalidate even with no moves: the per-owner volume-list entry is keyed on
    // the handle, so a rename orphans it whether or not anything moved.
    await invalidateRenamedCaches(c, userId ?? email, moves);
  }

  const profile = await scope.get(Tokens.UserService).getProfileByEmail(email);
  return c.json({ email, username: profile.username });
}

/**
 * `GET /users/:username`.
 *
 * Returns 404 for an unknown or reserved handle. It previously answered 200
 * echoing whatever the caller asked for, because `getByUsername` swallowed its
 * own errors and returned null — so the endpoint could not be used to test
 * whether a handle is available while looking like a success.
 *
 * The `?? username` fallback is gone for the same reason. A row can exist with a
 * null `username` (provisioned but not yet bootstrapped), and echoing the
 * caller's input for it would reintroduce the exact bug the doc describes. A
 * row without a handle is a 404 here: the handle the caller asked about does
 * not exist.
 */
async function handleUserProfile(c: ApiContext): Promise<Response> {
  const username = (c.req.param('username') ?? '').trim();
  const user = await BaseRoute.getScope(c).get(Tokens.UserService).getByUsername(username);
  const resolved = user?.username;
  return typeof resolved === 'string' && resolved !== ''
    ? c.json({ username: resolved })
    : BaseRoute.jsonError(c, 'User not found', 404);
}

function registerUserProfileRoutes(app: App): void {
  app.get('/user/me', (c) => withErrorMapping(c, () => handleMe(c)));
  app.patch('/user/me/username', (c) => withErrorMapping(c, () => handleRenameUsername(c)));
  app.get('/users/:username', (c) => withErrorMapping(c, () => handleUserProfile(c)));
}

export { registerUserProfileRoutes };
