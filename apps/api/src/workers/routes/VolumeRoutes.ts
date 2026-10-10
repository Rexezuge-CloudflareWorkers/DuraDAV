import { Tokens } from '@durable-dav/backend-services/composition';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import { readDavHrefPrefixMode } from '@durable-dav/shared/constants';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';
import { ErrorSanitizationUtil } from '@durable-dav/shared/utils';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { getVolumeStub } from '../doStubs';
import { getCachedVolumeList, invalidateVolumeCaches, invalidateVolumeListCache, putCachedVolumeList } from './DavReadCache';
import { VolumeScopedRoute, requireUser, withErrorMapping } from './VolumeScopedRoute';
import type { VolumeRequestContext } from './VolumeScopedRoute';

type App = ApiApp;

/**
 * Page size for the volume list.
 *
 * Matches `MAX_VOLUMES_PER_USER`'s default, so the list is complete for any
 * account within quota. If an operator raises the quota, this has to be raised
 * with it — otherwise the dashboard silently truncates. Truncation is the
 * failure mode to avoid here: the API answers 200 with a short list and no
 * indication that anything is missing.
 */
const MAX_VOLUMES_PER_USER = 100;

type VolumeJson = {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  /**
   * How this bucket's `DAV:href` values are anchored. Always present, so the
   * dashboard never has to distinguish "not reported" from "conforming".
   */
  hrefPrefixMode: DavHrefPrefixMode;
  href: string;
};

function toVolumeJson(r: { owner: string; name: string; description: string | null; is_private: number; href_prefix_mode: string }): VolumeJson {
  return {
    owner: r.owner,
    name: r.name,
    fullName: `${r.owner}/${r.name}`,
    description: r.description,
    isPrivate: Number(r.is_private) === 1,
    hrefPrefixMode: readDavHrefPrefixMode(r.href_prefix_mode),
    href: `/${r.owner}/${r.name}/`,
  };
}

/**
 * `GET /user/volumes` — KV-cached per account id (60s).
 *
 * No `Cache-Control` argument is passed on purpose: `securityHeaders` applies
 * `Cache-Control: no-store` to every `/user/*` response *after* the handler
 * runs, overriding whatever the handler set. The four previous
 * `cacheControlFor('meta')` arguments were unreachable intent.
 */
async function handleListVolumes(c: ApiContext): Promise<Response> {
  const identity = requireUser(c);
  if (identity instanceof Response) return identity;
  const { email, userId } = identity;
  const scope = BaseRoute.getScope(c);
  // The list is the caller's own buckets, so it is keyed on the account id
  // rather than the sign-in address: an address-keyed cache entry is orphaned
  // the moment the user changes address, and the old entry would keep being
  // served under a key nothing can invalidate any more.
  const cache = scope.get(Tokens.KvCache);
  const cacheKey = userId ?? email;
  try {
    const cached = await getCachedVolumeList<VolumeJson[]>(cache, cacheKey);
    if (cached) return c.json({ volumes: cached });
  } catch {
    // Fail-soft: fall through to D1.
  }
  // No `.catch(() => [])`: a D1 failure was indistinguishable from "you own
  // nothing", and the empty result was then written to KV for 60s — so a
  // one-second blip made a user's volume list look empty for a minute.
  const rows = await listOwnedVolumes(scope, userId, email);
  const volumes = rows.map(toVolumeJson);
  await putCachedVolumeList(cache, cacheKey, volumes);
  return c.json({ volumes });
}

/**
 * The caller's buckets, preferring the account key.
 *
 * The address fallback is for a pre-0004 database (`users.id` absent) and for
 * fake-DB doubles in tests that do not implement the id-keyed query. It is
 * tried only after the id path has failed, so a real id-keyed read is never
 * masked by it.
 */
async function listOwnedVolumes(scope: ReturnType<typeof BaseRoute.getScope>, userId: string | null, email: string): Promise<DavVolumeRow[]> {
  const dao = await scope.get(Tokens.DavVolumeDAO)();
  if (userId) {
    try {
      return await dao.listByOwnerUserId(userId, MAX_VOLUMES_PER_USER);
    } catch (error) {
      // Fall through to the address path. Logged because a genuine D1 failure
      // is indistinguishable here from the intended pre-0004 case, and a
      // silently-wrong volume list is hard to notice from the outside.
      console.warn('id-keyed volume list failed; falling back to the address path', {
        userId,
        error: ErrorSanitizationUtil.stackForLog(error),
      });
    }
  }
  return dao.listByOwnerEmail(email, MAX_VOLUMES_PER_USER);
}

class VolumeDetail extends VolumeScopedRoute {
  // Declared `async` to satisfy the abstract signature; the body is a
  // synchronous `c.json` on the row the guard already read.
  protected run(c: ApiContext, { row }: VolumeRequestContext): Promise<Response> {
    // Served straight from the row the guard already read.
    //
    // This endpoint used to keep a KV read-through cache, but the ownership
    // guard has to load the volume from D1 anyway — so the cache could never
    // avoid the query it existed to skip, while still costing a KV write on
    // every volume mutation and an invalidation path on rename. The list
    // endpoint is the one that benefits, since it has no per-row guard.
    return Promise.resolve(c.json(toVolumeJson(row)));
  }
}

class UpdateVolume extends VolumeScopedRoute {
  protected async run(c: ApiContext, { scope, email, userId, viewer, row }: VolumeRequestContext): Promise<Response> {
    // Widened to `unknown` on purpose: these are client-controlled values, and
    // `parseVolumePatch` is the runtime check that they are what they claim.
    const read = await BaseRoute.readJson<{ description?: unknown; isPrivate?: unknown; hrefPrefixMode?: DavHrefPrefixMode }>(c);
    const unreadable = BaseRoute.rejectUnreadableBody(c, read);
    if (unreadable) return unreadable;
    const { body } = read;
    // Rebuilt field-by-field so an absent key stays absent: `?? null` would turn
    // a missing `description` into an explicit clear, and the service's
    // "Nothing to update" check counts presence, not truthiness.
    const patch = {
      ...(('description' in body) && { description: body.description }),
      ...(('isPrivate' in body) && { isPrivate: body.isPrivate }),
      ...(('hrefPrefixMode' in body) && { hrefPrefixMode: body.hrefPrefixMode }),
    };
    const updated = await scope.get(Tokens.VolumeService).updateVolume(row.owner, row.name, viewer, patch);
    const cache = scope.get(Tokens.KvCache);
    await invalidateVolumeListCache(cache, userId ?? email);
    // Cached PROPFIND bodies are keyed on volume+path+depth+request-body, with
    // no term for the href mode — so a mode flip would keep serving 207s in the
    // old shape for the rest of their TTL. Purging on change is what makes the
    // setting take effect on the next request rather than up to two minutes
    // later, which is the whole point of the control.
    if (patch.hrefPrefixMode !== undefined && patch.hrefPrefixMode !== readDavHrefPrefixMode(row.href_prefix_mode)) {
      await invalidateVolumeCaches(cache, row.owner, row.name);
    }
    return c.json(toVolumeJson(updated));
  }
}

class DeleteVolume extends VolumeScopedRoute {
  protected async run(c: ApiContext, { scope, email, userId, row }: VolumeRequestContext): Promise<Response> {
    // The D1 delete is the authoritative step. It must NOT be swallowed:
    // swallowing it let the route destroy the DO filesystem and answer
    // `{"ok":true}` while the D1 row (and therefore the whole WebDAV surface)
    // survived — a "deleted" bucket that was still live.
    await scope.get(Tokens.VolumeService).deleteVolume(row.owner, row.name);
    // DO cleanup is now pure garbage collection — the bucket is already gone
    // from D1, so a failure is safe to absorb, but the caller is told so it can
    // be retried rather than silently leaving orphaned bytes.
    let doCleanupFailed = false;
    try {
      await getVolumeStub(c.env, row.owner, row.name).deleteVolume();
    } catch (error) {
      doCleanupFailed = true;
      console.error('Volume DO cleanup failed after D1 delete', {
        owner: row.owner,
        volume: row.name,
        error: ErrorSanitizationUtil.stackForLog(error),
      });
    }
    const cache = scope.get(Tokens.KvCache);
    await invalidateVolumeListCache(cache, userId ?? email);
    await invalidateVolumeCaches(cache, row.owner, row.name);
    return c.json({ ok: true, doCleanupFailed });
  }
}

async function handleCreateVolume(c: ApiContext): Promise<Response> {
  const identity = requireUser(c);
  if (identity instanceof Response) return identity;
  const { email, userId } = identity;
  const scope = BaseRoute.getScope(c);
  // Deliberately widened: these are client-controlled JSON values whose real
  // types are unknown until `parseVolumePatch` has checked them. Typing them
  // as the accepted shape here would make `createVolume`'s own guard a
  // compile-time lie rather than a runtime check.
  const read = await BaseRoute.readJson<{
    owner?: string;
    name?: string;
    isPrivate?: unknown;
    description?: unknown;
    hrefPrefixMode?: DavHrefPrefixMode;
  }>(c);
  const unreadable = BaseRoute.rejectUnreadableBody(c, read);
  if (unreadable) return unreadable;
  const { body } = read;
  if (!body.owner || !body.name) return BaseRoute.jsonError(c, 'owner and name are required', 400);
  // `VolumeService` enforces owner == caller's username and fails closed, so
  // the route does not duplicate that check. `description`, `isPrivate` and
  // `hrefPrefixMode` are passed through with their *declared* types intact
  // rather than pre-defaulted: `?? true` would turn a client-sent
  // `isPrivate: "false"` into a boolean before the validator ever saw it, which
  // is the one outcome the private-by-default rule must not produce by
  // accident. `parseVolumePatch` owns the type checks and answers 400.
  const created = await scope.get(Tokens.VolumeService).createVolume({
    owner: body.owner,
    name: body.name,
    description: body.description,
    isPrivate: body.isPrivate,
    hrefPrefixMode: body.hrefPrefixMode,
    creatorEmail: email,
  });
  await invalidateVolumeListCache(scope.get(Tokens.KvCache), userId ?? email);
  return c.json(toVolumeJson(created), 201);
}

function registerVolumeRoutes(app: App): void {
  app.get('/user/volumes', (c) => withErrorMapping(c, () => handleListVolumes(c)));
  app.post('/user/volumes', (c) => withErrorMapping(c, () => handleCreateVolume(c)));
  const detail = new VolumeDetail();
  const update = new UpdateVolume();
  const remove = new DeleteVolume();
  app.get('/user/volumes/:owner/:volume', (c) => detail.handle(c));
  app.patch('/user/volumes/:owner/:volume', (c) => update.handle(c));
  app.delete('/user/volumes/:owner/:volume', (c) => remove.handle(c));
}

export { registerVolumeRoutes };
export type { VolumeJson };
