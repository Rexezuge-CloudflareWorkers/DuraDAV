import { Tokens } from '@durable-dav/backend-services/composition';
import { SUPPORT_METHODS, DAV_CLASS, stripSlashes } from '@durable-dav/webdav';
import { readDavHrefPrefixMode } from '@durable-dav/shared/constants';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { getVolumeStub } from '../doStubs';
import { invalidateVolumeCaches, invalidatesReadCache } from './DavReadCache';
import { resolveDestination } from './davDestination';
import { readPageParams, stripPageParams } from './davPageParams';
import { applyDavForwardHeaders } from './davForwardHeaders';
import { VolumeScopedRoute } from './VolumeScopedRoute';
import type { VolumeRequestContext } from './VolumeScopedRoute';

type App = ApiApp;

function innerFromPath(pathname: string): string {
  // Browser prefix is /user/volumes/:owner/:volume/files[/inner...].
  // Split on '/' so owner/volume case or encoding never breaks extraction.
  const parts = stripSlashes(pathname).split('/');
  return parts.length <= 5 ? '' : parts.slice(5).join('/');
}

/**
 * Session-authenticated browser plane.
 *
 * Same DO content as the WebDAV plane, but authorised by the Access session so
 * a private bucket never answers 401 + `WWW-Authenticate` (which would pop a
 * native username/password prompt in the SPA's file browser).
 *
 * `404` is the not-owner response here, not `403`: this plane deliberately
 * hides existence so a stranger cannot probe which buckets exist. That was
 * previously duplicated inline and had already drifted from the credential
 * plane, which returned 403.
 */
class BrowserVolumeRoute extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, email, row }: VolumeRequestContext): Promise<Response> {
    const method = c.req.method;
    if (!SUPPORT_METHODS.includes(method)) {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS },
      });
    }

    const stub = getVolumeStub(c.env, row.owner, row.name);
    const davBase = `/${row.owner}/${row.name}`;
    // The bucket's own setting, read from the row the ownership guard already
    // loaded. This plane honours it too, so one bucket answers one href shape
    // regardless of which plane a client used to reach it.
    const hrefPrefixMode = readDavHrefPrefixMode(row.href_prefix_mode);
    const url = new URL(c.req.url);
    const inner = innerFromPath(url.pathname);
    // Paging arrives as `?page=`/`?limit=` so a proxy in front of this plane
    // forwards it without an allowlist change, and is re-emitted as request
    // headers because the DO's URL is rebuilt from the DAV base below — the DO
    // would never see the query string. The parameters are stripped from the
    // forwarded URL so they cannot reach the DAV surface as a `DAV:` href.
    const pageParams = readPageParams(url);
    const forwardUrl = pageParams === null ? url : stripPageParams(url);
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const destination = resolveDestination(c.req.raw.headers.get('Destination'), c.req.url, davBase, hrefPrefixMode);
    if (c.req.raw.headers.has('Destination') && !destination.ok) {
      // §10.3: a destination on another server cannot be satisfied. Any other
      // unmappable destination is a plain 400, as on the DAV plane.
      return destination.reason === 'cross-origin'
        ? c.json({ Exception: { Type: 'BadGateway', Message: 'Cross-origin Destination' } }, 502)
        : c.json({ Exception: { Type: 'BadRequest', Message: 'Invalid Destination' } }, 400);
    }
    // Forward to the DAV-base URL (not the browser URL): the DO falls back to
    // pathname parsing when X-Dav-Path is empty (root), and the browser prefix
    // would resolve to a nonexistent inner path there.
    const forward = new Request(`${forwardUrl.origin}${davBase}/${inner}`, {
      method,
      headers: applyDavForwardHeaders(c.req.raw.headers, {
        base: davBase,
        inner,
        hrefPrefixMode,
        // Session identity is authoritative on this plane, so the caller's
        // resolved address is the owner — not whatever a Basic header claimed.
        userEmail: email,
        // Only COPY/MOVE act on a Destination, and only the canonical form.
        destination: destination.ok ? destination.destination : undefined,
        // Paging arrived as `?page=`/`?limit=` and is re-emitted here, because
        // the DO's URL is rebuilt from the DAV base and it would never see the
        // query string.
        page: pageParams,
      }),
      body: hasBody ? c.req.raw.body : undefined,
      ...(hasBody && { duplex: 'half' }),
    });
    const response = await stub.fetch(forward);
    // Browser-plane writes share the same DO state as the WebDAV plane, so
    // invalidate the front read cache too (fail-soft, best-effort). Same
    // allow-list the WebDAV plane uses, so the two cannot drift.
    if (invalidatesReadCache(method)) {
      try {
        await invalidateVolumeCaches(scope.get(Tokens.KvCache), row.owner, row.name);
      } catch {
        // Never break writes on cache errors.
      }
    }
    return response;
  }
}

function registerVolumeBrowserRoutes(app: App): void {
  const handler = new BrowserVolumeRoute();
  const methods = [...SUPPORT_METHODS] as never[];
  app.on(methods, '/user/volumes/:owner/:volume/files', (c) => handler.handle(c));
  app.on(methods, '/user/volumes/:owner/:volume/files/*', (c) => handler.handle(c));
}

export { registerVolumeBrowserRoutes, innerFromPath };
