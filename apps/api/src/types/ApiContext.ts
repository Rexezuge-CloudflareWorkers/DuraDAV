import type { Context, Hono } from 'hono';

/**
 * The single Hono context type for this worker.
 *
 * Why one declaration: the same type was previously re-declared under eight
 * different names across the route files (`HonoContext`, `RequestContext` ×2,
 * `App` ×3, `CredentialApp`, `UserApp`, `AppRouter`). Eight spellings of one
 * type is what forced the 25 `as never` casts at the `BaseRoute.getScope` and
 * `davAuthForVolume` call sites — a hand-rolled partial "DavContext" interface
 * that omitted `get`/`set`/`arrayBuffer` could not satisfy them.
 */
export type ApiEnv = {
  Bindings: Env;
  Variables: {
    /**
     * The address the caller authenticated with, lowercased. This is the
     * *sign-in* address, not the account key: it changes when a user moves to a
     * new address. Use it for logging, display, and the rate-limit key.
     */
    AuthenticatedUserEmailAddress: string;
    /**
     * The stable account key (migration 0004).
     *
     * Every ownership and permission decision keys on this, not the address:
     * `owner_email` is a frozen anchor that never changes, so matching it
     * against a live sign-in address locked users out of their own buckets the
     * moment they changed address.
     *
     * Optional because a pre-0004 database has no `users.id`; the ownership
     * helpers treat its absence as "fall back to the anchor comparison" rather
     * than as a denial.
     */
    AuthenticatedUserId?: string;
  };
};

export type ApiContext = Context<ApiEnv>;

export type ApiApp = Hono<ApiEnv>;
