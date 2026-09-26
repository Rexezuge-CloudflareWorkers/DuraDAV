import { Tokens } from '@durable-dav/backend-services/composition';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { davAuthForVolume } from '@/middleware/DavAuth';
import { getVolumeStub } from '../doStubs';
import { DAV_CLASS, SUPPORT_METHODS, applyCors } from '@durable-dav/webdav';
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

function isDavMethod(method: string): boolean {
  return SUPPORT_METHODS.includes(method);
}

function needsWrite(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(method);
}

function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/**
 * 200/304 response builder for cached DAV reads.
 *
 * Single place for the header set, so the 200 and 304 arms cannot drift.
 * Previously the 304 arm set only `ETag`, omitting the `Cache-Control` the
 * 200 arm sent, and the 200 header block was written three separate times
 * with subtly different field sets.
 */

/**
200/304 for a body already materialised from the DO.
*/

async function handleDav(c: DavContext, owner: string, volume: string, inner: string): Promise<Response> {
  const method = c.req.method;
  if (!isDavMethod(method)) {
    return cors(c, new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS } }));
  }
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
  const auth = await davAuthForVolume(c, owner, volume, needsWrite(method));
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
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
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

function registerDavRoutes(app: App): void {
  // WebDAV volume surface: /:owner/:volume/* (multi-volume from day one).
  // Depth handling lives in the DO; the front adds fail-soft KV caching
  // for GET/PROPFIND and invalidation on writes (Git RepoReadCache pattern).
  const methods = [...SUPPORT_METHODS] as never[];
  app.on(methods, '/:owner/:volume/*', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    const url = new URL(c.req.url);
    const base = `/${owner}/${volume}`;
    // Preserve display case for the base until auth resolves canonical names;
    // `handleDav` re-derives the canonical base from the auth result.
    const suffix = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : '';
    const inner = stripSlashes(suffix);
    return handleDav(c, owner, volume, inner);
  });

  app.on(methods, '/:owner/:volume', async (c) => {
    const owner = c.req.param('owner') ?? '';
    const volume = c.req.param('volume') ?? '';
    return handleDav(c, owner, volume, '');
  });

  // Terminal catch-all. Without it, a non-DAV method on a volume path matched
  // no route and fell through to Hono's default 404, so the 405 the code
  // already contained was unreachable and clients saw "not found" for a
  // resource that plainly exists.
  const methodNotAllowed = (c: DavContext): Response =>
    cors(c, new Response('Method Not Allowed', { status: 405, headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS } }));
  app.all('/:owner/:volume', methodNotAllowed as never);
  app.all('/:owner/:volume/*', methodNotAllowed as never);
}

export { registerDavRoutes };
export type { App };
