import { Tokens } from '@durable-dav/backend-services/composition';
import { isVolumeOwner } from '@durable-dav/backend-services/dav';
import type { ViewerIdentity } from '@durable-dav/backend-services/dav';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import type { Container } from '@durable-dav/backend-runtime/di';
import { BaseRoute } from '@/endpoints/IBaseRoute';

import type { ApiContext } from '@/types/ApiContext';

/**
Everything a volume-scoped handler needs after the guard has run.
*/
export interface VolumeRequestContext {
  scope: Container;
  /**
  The caller's sign-in address, lowercased. For display and the rate-limit key.
  */
  email: string;
  /**
  The caller's stable account key (migration 0004), or null on a pre-0004
  database. What ownership is decided on.
  */
  userId: string | null;
  /**
  The caller as the ownership helpers see one.
  */
  viewer: ViewerIdentity;
  /**
  Canonical owner handle from D1 (not the raw URL segment).
  */
  owner: string;
  /**
  Canonical volume name from D1.
  */
  volume: string;
  /**
  The resolved volume row.
  */
  row: DavVolumeRow;
}

/**
How a volume-scoped plane reports "not yours".

The two planes deliberately differ: the session-authenticated browser plane
hides existence (404) so a stranger cannot probe which buckets exist, while
the credential plane returns 403. Centralising the choice here is what keeps
that documented invariant from drifting — it had already drifted once, with
`CredentialRoutes` returning 403 on a foreign volume while the browser plane
returned 404.
*/
type NotOwnerStatus = 403 | 404;

const UNAUTHORIZED_BODY = { Exception: { Type: 'Unauthorized', Message: 'Unauthorized' } } as const;
const NOT_FOUND_BODY = { Exception: { Type: 'NotFound', Message: 'Volume not found' } } as const;
const FORBIDDEN_BODY = { Exception: { Type: 'Forbidden', Message: 'Forbidden' } } as const;

/**
 * Resolve the authenticated caller, or answer 401.
 *
 * `/user/*` is already behind `userAuthentication()`, so this reads the values
 * that middleware stored rather than re-running the whole authentication chain.
 * The typed-as-always-present email is guarded because its absence would
 * otherwise be a `TypeError` (500) rather than a 401.
 */
function requireUser(c: ApiContext): Response | { email: string; userId: string | null } {
  const email = c.get('AuthenticatedUserEmailAddress');
  return typeof email !== 'string' || email === '' ? c.json(UNAUTHORIZED_BODY, 401) : { email: email.toLowerCase(), userId: (c.get('AuthenticatedUserId')) ?? null };
}

/**
 * Template method for every `/user/volumes/:owner/:volume/...` handler.
 *
 * Seven handlers across three route files each opened with the same six lines:
 * resolve scope, resolve identity, look the volume up, 404 if missing, 403/404
 * if not the owner. That preamble is where the bugs lived — one copy swallowed
 * the volume lookup so a D1 outage looked like a 404, another used 403 where
 * the plane's contract said 404.
 *
 * Subclasses implement `run`; this class owns the guard and the error mapping.
 */
abstract class VolumeScopedRoute {
  constructor(private readonly notOwnerStatus: NotOwnerStatus = 403) {}

  /**
  The per-handler work, after authentication and ownership are established.
  */
  protected abstract run(c: ApiContext, ctx: VolumeRequestContext): Promise<Response>;

  public async handle(c: ApiContext): Promise<Response> {
    try {
      return await this.guard(c);
    } catch (error) {
      return BaseRoute.toErrorResponse(c, error);
    }
  }

  private async guard(c: ApiContext): Promise<Response> {
    const identity = requireUser(c);
    if (identity instanceof Response) return identity;
    const { email, userId } = identity;

    const scope = BaseRoute.getScope(c);
    const owner = (c.req.param('owner') ?? '').trim();
    const volume = (c.req.param('volume') ?? '').trim();
    // No `.catch(() => null)`: that made a D1 outage indistinguishable from a
    // missing bucket, so clients cached a 404 for a bucket that still existed.
    const row = await scope.get(Tokens.VolumeService).getVolume(owner, volume);
    if (!row) return c.json(NOT_FOUND_BODY, 404);
    const viewer: ViewerIdentity = { userId, email };
    if (!isVolumeOwner(viewer, row)) {
      return this.notOwnerStatus === 404 ? c.json(NOT_FOUND_BODY, 404) : c.json(FORBIDDEN_BODY, 403);
    }
    return this.run(c, { scope, email, userId, viewer, owner: row.owner, volume: row.name, row });
  }
}

/**
 * Map thrown domain errors to the AWS error envelope.
 *
 * Handlers that are not volume-scoped still need this: `createVolume` throws
 * `ForbiddenError` for a foreign owner and `BadRequestError` for a duplicate
 * name, and without the mapping both escape to `app.onError` as a masked 500.
 */
async function withErrorMapping(c: ApiContext, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return BaseRoute.toErrorResponse(c, error);
  }
}

export { VolumeScopedRoute, requireUser, withErrorMapping,  };
export type { NotOwnerStatus };

export {MiddlewareHandlers} from '@/middleware/MiddlewareHandlers';