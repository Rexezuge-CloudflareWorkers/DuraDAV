import { AbstractEntrypointWorker } from '@durable-dav/backend-runtime/base';
import { fromHono } from 'chanfana';
import type { HonoOpenAPIRouterType } from 'chanfana';
import { Hono } from 'hono';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { ErrorSanitizationUtil } from '@durable-dav/shared/utils';
import type { Next } from 'hono';
import { MiddlewareHandlers, registerRateLimits, securityHeaders } from '@/middleware';
import type { ApiContext, ApiEnv } from '@/types/ApiContext';
import { scopeMiddleware } from '@/middleware/scopeMiddleware';
import { RESERVED_NAMESPACE_NAMES_LIST } from '@durable-dav/shared/constants';
import { registerDavRoutes } from './routes/DavRoutes';
import { registerVolumeRoutes } from './routes/VolumeRoutes';
import { registerVolumeBrowserRoutes } from './routes/VolumeBrowserRoutes';
import { registerCredentialRoutes } from './routes/CredentialRoutes';
import { registerReplicationRoutes } from './routes/ReplicationRoutes';
import { registerUserProfileRoutes } from './routes/UserRoutes';
import { SPA_HTML } from '@/generated/spa-shell';
import { acceptsHtml } from './acceptsHtml';

type AppRouter = HonoOpenAPIRouterType<ApiEnv>;

/**
 * Serve the SPA shell to browser document navigations, else fall through.
 * Registered for both `/:owner/:volume` and `/:owner/:volume/` because Hono's
 * bare pattern does not match a trailing slash, which used to send a bookmarked
 * `https://host/alice/demo/` to the DO's raw HTML listing instead.
 */
async function serveSpaForBrowser(c: ApiContext, next: Next): Promise<Response | void> {
  if (c.req.method === 'GET' && acceptsHtml(c.req.raw)) return c.html(SPA_HTML);
  await next();
}

class DurableDavWorker extends AbstractEntrypointWorker {
  protected readonly app: AppRouter;
  private configChecked = false;

  constructor() {
    super();

    const app = new Hono<ApiEnv>();

    app.use('*', securityHeaders());
    app.onError((error, c) => {
      console.error('Unhandled worker error', ErrorSanitizationUtil.stackForLog(error));
      return c.json({ Exception: { Type: 'InternalServerError', Message: 'Internal Server Error.' } }, 500);
    });

    app.get('/health', (c) => c.json({ ok: true, service: 'durable-dav' }));

    // Web SPA shell (Vite build embeds `apps/web/dist/index.html` into
    // `apps/api/src/generated/spa-shell.ts`; no per-request scope needed).
    app.get('/', (c) => c.html(SPA_HTML));
    app.get('/new', (c) => c.html(SPA_HTML));
    app.get('/settings', (c) => c.html(SPA_HTML));
    // Single-segment profile shell — never shadow reserved API/UI roots
    // (`/health`, `/docs`, `/user`, …). Reserved names fall through so the
    // exact routes win.
    //
    // The deny-list must be owned here, not borrowed from
    // `RESERVED_NAMESPACE_NAMES`: that set is a *username* concern and only
    // contained `docs`, so `fromHono`'s `/openapi.json`, `/openapi.yaml` and
    // `/redocs` — registered after this handler, and therefore losing Hono's
    // same-shape resolution order — were all shadowed by the SPA shell. The
    // Swagger page at `/docs` fetched `/openapi.json` and rendered empty.
    const NON_PROFILE_SEGMENTS: ReadonlySet<string> = new Set([...RESERVED_NAMESPACE_NAMES_LIST, 'openapi.json', 'openapi.yaml', 'redocs']);
    app.get('/:username', async (c, next) => {
      const segment = (c.req.param('username') ?? '').toLowerCase();
      if (NON_PROFILE_SEGMENTS.has(segment)) {
        await next();
        return;
      }
      return c.html(SPA_HTML);
    });

    app.use('*', scopeMiddleware);

    // Abuse control. Must sit after `scopeMiddleware` so the limiter can read
    // the authenticated identity, and before every route so no endpoint can
    // be added without inheriting a limit.
    registerRateLimits(app);

    app.use('/user/*', MiddlewareHandlers.userAuthentication());

    registerVolumeRoutes(app);
    registerVolumeBrowserRoutes(app);
    registerCredentialRoutes(app);
    registerReplicationRoutes(app);
    registerUserProfileRoutes(app);

    // Volume-root content negotiation: browser document navigations
    // (`Accept: text/html`) get the SPA shell, whose VolumeView drives
    // subpaths client-side via `?path=`; WebDAV and file clients
    // (`Accept: */*`, `Depth`, …) fall through to the DO forward below.
    // Registered after `/user/*` so API JSON responses always win.
    //
    // Both the bare and trailing-slash forms are registered: Hono's
    // `/:owner/:volume` does not match `/alice/demo/`, so a browser with a
    // bookmark ending in `/` got the DO's raw HTML listing instead of the SPA.
    app.use('/:owner/:volume', serveSpaForBrowser);
    app.use('/:owner/:volume/', serveSpaForBrowser);
    registerDavRoutes(app);

    const openapi: AppRouter = fromHono(app, { docs_url: '/docs' });
    this.app = openapi;
  }

  protected async onRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fail-fast configuration check, once per isolate. `AppConfiguration.validate`
    // documents itself as "call at worker startup"; it was never called, so a
    // typo like `MAX_FILE_BYTES=banana` silently became the 50 MB default in
    // production and only ever surfaced in a test.
    if (!this.configChecked) {
      this.configChecked = true;
      for (const warning of AppConfiguration.fromEnv(env).validate()) console.error(warning);
    }
    return this.app.fetch(request, env, ctx);
  }

  protected onScheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.CRON_TASKS.idFromName('global');
    const stub = env.CRON_TASKS.get(id);
    ctx.waitUntil(
      stub
        .fetch(
          new Request('https://do/run', {
            method: 'POST',
            body: JSON.stringify({ cron: event.cron, scheduledTime: event.scheduledTime }),
          }),
        )
        .then((res: Response) => {
          // `!res.ok` already excludes 2xx, so the old `&& res.status !== 202`
          // guard was unreachable — and it would have suppressed the log for
          // exactly the case that matters (a 202 is a normal single-flight
          // skip, not an error).
          if (!res.ok) console.error('CronTasksWorker error', res.status);
        })
        .catch((error: unknown) => console.error('Cron invoke failed', error)),
    );
    return Promise.resolve();
  }
}

export { DurableDavWorker };
