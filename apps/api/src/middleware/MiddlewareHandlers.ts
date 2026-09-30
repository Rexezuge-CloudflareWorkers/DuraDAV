import type { Context, Next } from 'hono';
import { Tokens } from '@durable-dav/backend-services/composition';
import type { AccessIdentityContext } from '@durable-dav/backend-services/auth';
import { UnauthorizedError, ForbiddenError, DefaultInternalServerError } from '@durable-dav/backend-errors';
import { ErrorSanitizationUtil } from '@durable-dav/shared/utils';
import { BaseRoute } from '../endpoints/IBaseRoute';

type RequestContext = Context<{
  Bindings: Env;
  Variables: { AuthenticatedUserEmailAddress: string; AuthenticatedUserId?: string };
}>;

function getScope(c: RequestContext): ReturnType<typeof BaseRoute.getScope> {
  return BaseRoute.getScope(c);
}

/**
 * Authenticate, provision if new, and return the caller's account.
 *
 * One resolution per request, reused by `userAuthentication` and `requireUser`:
 * `UserService.upsertUser` resolves the address through the `user_emails`
 * registry, so a user who has changed their address lands on their existing
 * account instead of being provisioned a second, empty one.
 */
async function authenticateUserIdentity(c: RequestContext): Promise<{ email: string; userId: string | null }> {
  const scope = getScope(c);
  const email = await scope
    .get(Tokens.AccessAuthService)
    .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
  const account = await scope.get(Tokens.UserService).upsertUser(email);
  return { email, userId: account.id };
}

async function userAuthenticationHandler(c: RequestContext, next: Next): Promise<Response | void> {
  try {
    const identity = await authenticateUserIdentity(c);
    c.set('AuthenticatedUserEmailAddress', identity.email);
    c.set('AuthenticatedUserId', identity.userId ?? undefined);
    await next();
  } catch (error: unknown) {
    const status = error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : 500;
    if (status === 500) {
      console.error('userAuthentication failed:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      return c.json(
        {
          Exception: {
            Type: DefaultInternalServerError.getErrorType(),
            Message: DefaultInternalServerError.getErrorMessage(),
          },
        },
        500,
      );
    }
    const type = error instanceof ForbiddenError ? 'Forbidden' : 'Unauthorized';
    const message = error instanceof Error ? error.message : 'Unauthorized';
    return c.json({ Exception: { Type: type, Message: message } }, status as 401);
  }
}

class MiddlewareHandlers {
  public static userAuthentication(): (c: RequestContext, next: Next) => Promise<Response | void> {
    return userAuthenticationHandler;
  }
}

export { MiddlewareHandlers };
export type { RequestContext };
