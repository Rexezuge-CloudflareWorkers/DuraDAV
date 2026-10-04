/**
 * `RemoteVolume` over HTTPS, for any WebDAV server.
 *
 * Lives in `apps/background` rather than beside the interface it implements:
 * this is the layer that talks to the network. `packages/backend-services` holds
 * the planner and the contract and stays free of both `fetch` and the
 * `@durable-dav/webdav` dependency the parser needs.
 *
 * The transport is injected rather than reached for directly. That is not
 * testability theatre — it is the only way the redirect and SSRF rules below can
 * be exercised at all, because a real `fetch` to a blocked host is exactly what
 * the tests must never perform.
 */

import { parseMultiStatus } from '@durable-dav/webdav';
import { MAX_REDIRECTS, RemoteUrlRejectedError, normalizeRemoteUrl, resolveRedirectUrl } from '@durable-dav/shared/net';
import { RemoteUnavailableError } from '@durable-dav/backend-services/replication';
import {
  DELETE_SUCCESS,
  classifyStatus,
  joinUrl,
  propfindBody,
  toInnerEntry,
  trimSlashes,
} from './davHttpProtocol';
import type { DavAuthHeader, DavHttpFetch } from './davHttpProtocol';
import { removeRecursive } from './recursiveDelete';
import type { RemoteEntry, RemoteListing, RemoteVolume } from '@durable-dav/backend-services/replication';

/**
 * Per-request timeout. Remote servers are frequently slow, not down.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

type DavHttpRemoteOptions = {
  baseUrl: string;
  /**
  Subdirectory on the remote to sync into. Normalised, no leading slash.
  */
  remotePath?: string;
  auth: DavAuthHeader;
  fetchImpl: DavHttpFetch;
  /**
   * Operator-configured host allowlist, applied to every hop.
   *
   * Empty by default, which refuses private and loopback addresses. Populated
   * only from `REPLICATION_ALLOWED_HOSTS`.
   */
  allowedHosts?: readonly string[];
  timeoutMs?: number;
};

type DavHttpRemoteDeps = {
  fetchImpl: DavHttpFetch;
  authHeader: DavAuthHeader;
  allowedHosts: readonly string[];
  timeoutMs: number;
};

class DavHttpRemote implements RemoteVolume {
  private readonly base: string;

  private readonly rootPathname: string;

  private readonly rootInner: string;

  private readonly deps: DavHttpRemoteDeps;

  constructor(options: DavHttpRemoteOptions) {
    const base = normalizeRemoteUrl(options.baseUrl, { allowedHosts: options.allowedHosts });
    this.base = base;
    const rootInner = trimSlashes(options.remotePath ?? '');
    // The configured root on the *remote* server, which may be a subdirectory
    // of the base and may itself be percent-encoded.
    const rootUrl = new URL(joinUrl(base, rootInner));
    this.rootPathname = decodeURIComponent(rootUrl.pathname);
    this.rootInner = rootInner;
    this.deps = {
      fetchImpl: options.fetchImpl,
      authHeader: options.auth,
      allowedHosts: options.allowedHosts ?? [],
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /**
  Inner path this remote is rooted at, for diagnostics.
  */
  public get root(): string {
    return this.rootInner;
  }

  /**
   * One request, with the redirect budget and a per-hop policy re-check.
   *
   * Manual redirect handling is not an optimisation. With the default
   * `redirect: 'follow'`, the platform fetches each `Location` itself and this
   * code never sees it — so the SSRF policy would be validated once against the
   * configured URL and then bypassed by whatever the *first* hop pointed at.
   *
   * The method is never rewritten across a redirect. A 303 conventionally means
   * "go GET the thing you just POSTed", which is right for HTML forms and
   * catastrophic for `PUT`/`DELETE`/`MKCOL`: the operation would appear to
   * succeed while writing nothing.
   */
  private async request(path: string, init: RequestInit & { method: string }): Promise<Response> {
    let target = joinUrl(this.base, this.rootInner, path);
    const visited = new Set<string>([target]);

    for (let hop = 0; ; hop += 1) {
      const headers = new Headers(init.headers);
      headers.set('User-Agent', 'durable-dav-replication/1.0');
      // One header, chosen once. Two adjacent `if`s here read as if the second
      // could overwrite the first.
      if (this.deps.authHeader.kind === 'basic') {
        headers.set('Authorization', `Basic ${this.deps.authHeader.value}`);
      } else if (this.deps.authHeader.kind === 'bearer') {
        headers.set('Authorization', `Bearer ${this.deps.authHeader.token}`);
      }

      const response = await this.deps.fetchImpl(target, {
        ...init,
        method: init.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.deps.timeoutMs),
      });

      const location = response.headers.get('Location');
      if (!location || response.status < 300 || response.status >= 400) return response;

      if (hop >= MAX_REDIRECTS) {
        throw new RemoteUnavailableError(`redirect budget of ${MAX_REDIRECTS} exhausted for ${init.method} ${path}`, response.status);
      }
      let next: string;
      try {
        next = resolveRedirectUrl(target, location, { allowedHosts: this.deps.allowedHosts });
      } catch (error) {
        if (error instanceof RemoteUrlRejectedError) {
          throw new RemoteUnavailableError(`redirect from ${init.method} ${path} was refused by the egress policy: ${error.message}`, response.status);
        }
        throw error;
      }
      if (visited.has(next)) {
        throw new RemoteUnavailableError(`redirect cycle detected for ${init.method} ${path}`, response.status);
      }
      visited.add(next);
      target = next;
    }
  }

  /**
   * PROPFIND one collection.
   *
   * A 404 on the requested collection is an empty listing rather than a
   * failure: the remote root is simply not created yet, which is the normal
   * state of a freshly configured target. Any *other* error is a failure —
   * reporting those as "empty" is how a `403` on one subdirectory turns into a
   * mass deletion.
   */
  private async propfind(path: string): Promise<RemoteListing> {
    const response = await this.request(path, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: propfindBody(),
    });

    if (response.status === 404) {
      if (trimSlashes(path) !== '') return { entries: [], complete: true };
      // A missing *root* means the configured subdirectory does not exist. Not
      // an error — the first push creates it.
      return { entries: [], complete: true };
    }
    if (response.status === 207) {
      const body = await response.text();
      const parsed = parseMultiStatus(body, { baseUrl: joinUrl(this.base, this.rootInner, path) });
      if (parsed === null) {
        throw new RemoteUnavailableError(`PROPFIND ${path} returned a body that is not a usable multistatus`, 207);
      }
      const entries: RemoteEntry[] = [];
      for (const resource of parsed) {
        const mapped = toInnerEntry(resource.pathname, this.rootPathname);
        if (mapped === null) continue;
        entries.push({
          path: mapped.inner,
          isCollection: resource.isCollection,
          etag: resource.etag,
          mtime: resource.lastModified,
          size: resource.size,
          contentType: resource.contentType,
        });
      }
      return { entries, complete: true };
    }
    if (response.status === 401 || response.status === 403) {
      throw new RemoteUnavailableError(classifyStatus(response.status, 'PROPFIND', path), response.status);
    }
    throw new RemoteUnavailableError(classifyStatus(response.status, 'PROPFIND', path), response.status);
  }

  public async list(path: string): Promise<RemoteListing> {
    return this.propfind(path);
  }

  /**
   * Look one path up.
   *
   * Implemented by asking the *parent*, not the path. `PROPFIND Depth: 1` on a
   * file answers with the file itself, which `toInnerEntry` drops as "the
   * requested collection" — and several servers answer `405` for depth on a
   * non-collection outright. Asking the parent is one request either way and
   * works for both shapes.
   */
  public async stat(path: string): Promise<RemoteEntry | null> {
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const listing = await this.propfind(parent);
    return listing.entries.find((entry) => entry.path === path) ?? null;
  }

  public async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const response = await this.request(path, { method: 'GET' });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new RemoteUnavailableError(classifyStatus(response.status, 'GET', path), response.status);
    }
    if (!response.ok || response.body === null) {
      throw new RemoteUnavailableError(classifyStatus(response.status, 'GET', path), response.status);
    }
    return response.body;
  }

  public async writeFile(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { contentType: string | null; ifMatch: string | null },
  ): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = {
      'Content-Type': options.contentType ?? 'application/octet-stream',
    };
    if (options.ifMatch !== null) headers['If-Match'] = options.ifMatch;
    const response = await this.request(path, { method: 'PUT', headers, body: body as BodyInit });
    if (response.status === 412) {
      throw new RemoteUnavailableError(`PUT ${path} was rejected by If-Match; the remote changed underneath the sync`, 412);
    }
    if (response.status !== 201 && response.status !== 204) {
      throw new RemoteUnavailableError(classifyStatus(response.status, 'PUT', path), response.status);
    }
    return { etag: response.headers.get('ETag') };
  }

  public async makeCollection(path: string): Promise<void> {
    // 405 means "already there", which is the normal case on a re-run and not
    // a failure. 409 means the parent is missing — the caller orders collections
    // shallowest-first, so this only happens if the remote disagrees about the
    // tree shape, and retrying would not help.
    const response = await this.request(path, { method: 'MKCOL' });
    if (response.status === 201 || response.status === 405) return;
    throw new RemoteUnavailableError(classifyStatus(response.status, 'MKCOL', path), response.status);
  }

  public async remove(path: string, options: { ifMatch: string | null; recursive: boolean }): Promise<void> {
    const deleteOne = async (target: string, ifMatch: string | null): Promise<void> => {
      const headers: Record<string, string> = {};
      if (ifMatch !== null) headers['If-Match'] = ifMatch;
      const response = await this.request(target, { method: 'DELETE', headers });
      if (DELETE_SUCCESS.has(response.status)) return;
      throw new RemoteUnavailableError(classifyStatus(response.status, 'DELETE', target), response.status);
    };
    await removeRecursive({
      root: path,
      ifMatch: options.ifMatch,
      recursive: options.recursive,
      listChildren: async (target) => {
        const listing = await this.propfind(target);
        return listing.entries;
      },
      deleteOne,
    });
  }

  /**
   * Does the remote speak WebDAV at all, and is it reachable?
   *
   * Separated from `list` so that "target misconfigured" and "target is empty"
   * are different answers. A `DAV:` header absent from the `OPTIONS` response
   * is the single most common configuration mistake — a URL that resolves to a
   * login page which happens to answer `200` — and it should be reported as
   * such rather than as a mysterious empty listing.
   */
  public async probe(): Promise<{ davClasses: string[] }> {
    const response = await this.request('', { method: 'OPTIONS' });
    if (response.status === 401 || response.status === 403) {
      throw new RemoteUnavailableError(classifyStatus(response.status, 'OPTIONS', '/'), response.status);
    }
    if (!response.ok) {
      throw new RemoteUnavailableError(classifyStatus(response.status, 'OPTIONS', '/'), response.status);
    }
    const dav = response.headers.get('DAV');
    if (dav === null) {
      throw new RemoteUnavailableError('target answered OPTIONS without a DAV header; the URL does not appear to be a WebDAV server');
    }
    return { davClasses: dav.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '') };
  }
}
export { DavHttpRemote };
export type { DavHttpRemoteOptions };
