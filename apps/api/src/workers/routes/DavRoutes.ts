import { Tokens } from '@durable-dav/backend-services/composition';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { davAuthForVolume } from '@/middleware/DavAuth';
import { getVolumeStub } from '../doStubs';
import { DAV_CLASS, SUPPORT_METHODS, allowsBody, applyCors, requiresWrite, stripSlashes } from '@durable-dav/webdav';
import { contentTtls, invalidateVolumeCaches, invalidatesReadCache } from './DavReadCache';
import { davHeaders, serveGet, servePropfind } from './DavReadServing';
import { resolveDestination } from './davDestination';

type App = ApiApp;
type DavContext = ApiContext;

/**
 * `applyCors` with the deployment's `SITE_URL` as the origin allow-list.
 * Wrapped so no call site can forget it and fall back to reflecting any
 * `Origin`.
 */
function cors(c: DavContext, response: Response): Response {
  return applyCors(response, c.req.raw, c.env.SITE_URL);
}

/**
Resolve the content-cache TTLs from `DAV_CACHE_TTL_SECONDS` (per request).
*/
function ttlsOf(c: DavContext): { prop: number; file: number } {
  return contentTtls(AppConfiguration.fromEnv(c.env).getDavCacheTtlSeconds());
}

/**
 * `405` for a volume path reached with a method the DAV surface does not
 * implement.
 *
 * The `Allow`/`DAV` pair is what tells a client this is a WebDAV resource and
 * which verbs it answers, so it is built in one place rather than at each of
 * the two call sites that need it.
 */
function methodNotAllowed(c: DavContext): Response {
  return cors(c, new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS } }));
}

async function handleDav(c: DavContext, owner: string, volume: string, inner: string): Promise<Response> {
  const method = c.req.method;
  // No method guard here. `handleDav` is only reachable from
  // `app.on(SUPPORT_METHODS, …)`, so the Fetch router has already restricted
  // the verb — a per-request re-check could only ever fail for a method the
  // router would have sent to the catch-all `methodNotAllowed` instead. That
  // catch-all is the reachable 405; the copy that used to live here was dead
  // code that made the route look like it validated its own methods.
  // `OPTIONS` is a capability probe, not an access to resource content. Many
  // DAV clients (and Windows/Office discovery) send it unauthenticated to learn
  // the compliance class; answering 401 on a private volume broke discovery
  // outright. Advertise capabilities without touching volume state.
  if (method === 'OPTIONS') {
    return cors(
      c,
      new Response(null, {
        status: 200,
        headers: {
          Allow: SUPPORT_METHODS.join(', '),
          DAV: DAV_CLASS,
          'MS-Author-Via': 'DAV',
          'Content-Length': '0',
        },
      }),
    );
  }
  const auth = await davAuthForVolume(c, owner, volume, requiresWrite(method));
  if (auth instanceof Response) return cors(c, auth);
  const stub = getVolumeStub(c.env, auth.owner, auth.volume);
  const base = `/${auth.owner}/${auth.volume}`;
  const cache = BaseRoute.getScope(c).get(Tokens.KvCache);
  const ttls = ttlsOf(c);
  if (method === 'GET' || method === 'HEAD') {
    return cors(c, await serveGet({ c, stub, auth, base, inner, cache, headOnly: method === 'HEAD', ttls }));
  }
  if (method === 'PROPFIND') {
    return cors(c, await servePropfind({ c, stub, auth, base, inner, cache, ttls }));
  }
  const hasBody = allowsBody(method);
  const headers = davHeaders(c, auth, base, inner);
  // `Destination` is canonicalised to the `/owner/volume` form before the DO
  // sees it, so the DO only ever has to understand one shape (see
  // `davDestination`). A `root`-mode bucket has to be able to accept the
  // root-relative hrefs it advertised, and the DO cannot tell those apart from
  // a traversal escape — so the front door resolves it, and rejects what it
  // cannot map rather than spending a DO round trip to be told 400.
  if (method === 'COPY' || method === 'MOVE') {
    const resolved = resolveDestination(c.req.raw.headers.get('Destination'), c.req.url, base, auth.hrefPrefixMode);
    // Plain `400 Bad Request`, matching what the DO has always answered for an
    // absent, cross-origin, or unmappable `Destination`. The browser plane's
    // `502` for a cross-origin destination is its own contract and unchanged.
    if (!resolved.ok) return cors(c, new Response('Bad Request', { status: 400 }));
    headers.set('Destination', resolved.destination);
  }
  const forward = new Request(c.req.url, {
    method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
    ...(hasBody && { duplex: 'half' }),
  });
  const response = await stub.fetch(forward);
  // Only content-changing methods drop the read cache (see
  // CONTENT_INVALIDATING_METHODS). This used to run for every remaining
  // method, which included OPTIONS/LOCK/UNLOCK.
  if (invalidatesReadCache(method)) {
    try {
      await invalidateVolumeCaches(cache, auth.owner, auth.volume);
    } catch {
      // Never break writes on cache errors.
    }
  }
  return cors(c, response);
}

/**
 * Volume-relative path, from the raw request URL.
 *
 * Must not be derived by slicing `url.pathname` with a base built from
 * `c.req.param()`. Hono **decodes** path params, while `url.pathname` is still
 * percent-encoded, so the two only agree when the client sent the owner and
 * volume verbatim. RFC 3986 §2.3 permits percent-encoding any unreserved
 * character, so `/%61lice/vol/file.txt` is the same resource as
 * `/alice/vol/file.txt` — and against the decoded base, `startsWith` failed,
 * `suffix` became `''`, and the request was forwarded with `X-Dav-Path: ''`.
 * The DO then served the **volume root** instead of `file.txt`: a `GET` returned
 * the root's collection listing, and a `PROPFIND` returned the wrong
 * multistatus. A wrong answer, not an error, which is the worst shape a path
 * bug can take.
 *
 * Slicing positionally sidesteps the encoding question entirely: the route
 * matched exactly two leading segments (`owner`, `volume`), so dropping them
 * leaves the inner path — still encoded, which is what `resolveInnerPath`'s
 * `decodeSegments` expects.
 */
function innerPathOf(requestUrl: string): string {
  const segments = new URL(requestUrl).pathname.split('/');
  // `['', owner, volume, ...rest]` for an absolute path.
  return stripSlashes(segments.slice(3).join('/'));
}

function registerDavRoutes(app: App): void {
  // WebDAV volume surface: /:owner/:volume/* (multi-volume from day one).
  // Depth handling lives in the DO; the front adds fail-soft KV caching
  // for GET/PROPFIND and invalidation on writes (Git RepoReadCache pattern).
  const methods = [...SUPPORT_METHODS] as never[];
  app.on(methods, '/:owner/:volume/*', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    return handleDav(c, owner, volume, innerPathOf(c.req.raw.url));
  });

  app.on(methods, '/:owner/:volume', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    return handleDav(c, owner, volume, '');
  });

  // Terminal catch-all. Without it, a non-DAV method on a volume path matched
  // no route and fell through to Hono's default 404, so clients saw "not
  // found" for a resource that plainly exists.
  app.all('/:owner/:volume', methodNotAllowed as never);
  app.all('/:owner/:volume/*', methodNotAllowed as never);
}

export { registerDavRoutes, innerPathOf };
export type { App };
