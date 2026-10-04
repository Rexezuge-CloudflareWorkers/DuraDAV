import { describe, expect, it } from 'vitest';
import { DavHttpRemote } from '../apps/background/src/replication/remote/DavHttpRemote';
import { basicAuthValue, joinUrl, toInnerEntry } from '../apps/background/src/replication/remote/davHttpProtocol';
import { RemoteUnavailableError } from '@durable-dav/backend-services/replication';

/**
 * The HTTP transport, against an injected fetch.
 *
 * The transport is injected rather than reached for directly, and that is the
 * only reason the redirect and SSRF rules below can be exercised at all: a real
 * `fetch` to a blocked host is exactly what these tests must never perform.
 */

const BASE = 'https://dav.example.com/remote.php/dav/files/me';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function remote(overrides: Partial<ConstructorParameters<typeof DavHttpRemote>[0]> = {}): DavHttpRemote {
  return new DavHttpRemote({
    baseUrl: BASE,
    auth: { kind: 'none' },
    fetchImpl: async () => new Response(null, { status: 404 }),
    ...overrides,
  });
}

function multistatus(entries: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`;
}

function fileResponse(href: string, etag = '"v1"'): string {
  return `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>${etag}</D:getetag>` +
    `<D:getcontentlength>5</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

describe('joinUrl', () => {
  it('encodes each segment rather than the whole path', () => {
    // One encode over the whole string would turn a `%2F` inside a filename into
    // a separator and address a different resource.
    expect(joinUrl('https://x.example/', 'a b', 'c/d')).toBe('https://x.example/a%20b/c/d');
    expect(joinUrl('https://x.example/', 'a%2Fb')).toBe('https://x.example/a%252Fb');
  });

  it('drops empty segments', () => {
    expect(joinUrl('https://x.example/', '', 'a')).toBe('https://x.example/a');
  });
});

describe('toInnerEntry', () => {
  it('strips the configured root', () => {
    expect(toInnerEntry('/root/a/b.txt', '/root')).toEqual({ inner: 'a/b.txt', href: '/root/a/b.txt' });
  });

  it('drops the collection itself', () => {
    // A `Depth: 1` PROPFIND always includes the requested collection; including
    // it would report the directory as a new file to push on every pass.
    expect(toInnerEntry('/root', '/root')).toBeNull();
    expect(toInnerEntry('/root/', '/root')).toBeNull();
  });

  it('rejects a path that climbed above the root', () => {
    expect(toInnerEntry('/other/a.txt', '/root')).toBeNull();
    expect(toInnerEntry('/root/../etc/passwd', '/root')).toBeNull();
  });
});

describe('basicAuthValue', () => {
  it('base64-encodes user:password', () => {
    expect(atob(basicAuthValue('me', 'pw'))).toBe('me:pw');
  });

  it('refuses a colon in the username', () => {
    // RFC 7617 forbids it and several servers truncate at the first one, so this
    // would authenticate as the wrong user with no error.
    expect(() => basicAuthValue('a:b', 'pw')).toThrow(/colon/);
  });
});

describe('DavHttpRemote.request — redirects', () => {
  it('follows a redirect and re-validates the hop', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url === `${BASE}/a.txt`
        ? new Response(null, { status: 302, headers: { Location: '/b.txt' } })
        : new Response('body', { status: 200 }),
    );
    const stream = await remote({ fetchImpl: impl }).readFile('a.txt');
    expect(await new Response(stream as ReadableStream).text()).toBe('body');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://dav.example.com/b.txt');
  });

  it('never rewrites the method across a redirect', async () => {
    // WebDAV is not form-encoded, so a 303 conventionally meaning "go GET what you
    // just POSTed" would make a PUT appear to succeed while writing nothing.
    const { impl, calls } = fakeFetch((url, init) => {
      const isFirstPut = init.method === 'PUT' && url.endsWith('/a.txt');
      return new Response(null, isFirstPut ? { status: 303, headers: { Location: '/b.txt' } } : { status: 201 });
    });
    await remote({ fetchImpl: impl }).writeFile('a.txt', new Uint8Array([1]), { contentType: null, ifMatch: null });
    // Two PUTs, never a GET.
    expect(calls.map((call) => call.init.method)).toEqual(['PUT', 'PUT']);
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/a.txt`, 'https://dav.example.com/b.txt']);
  });

  it('refuses a redirect the egress policy rejects', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/' } }));
    // The first hop is public and the second is the metadata service: validating
    // only the configured URL would be a classic TOCTOU.
    await expect(remote({ fetchImpl: impl }).readFile('a.txt')).rejects.toThrow(RemoteUnavailableError);
  });

  it('exhausts the redirect budget', async () => {
    let n = 0;
    const { impl } = fakeFetch(() => {
      n += 1;
      return new Response(null, { status: 302, headers: { Location: `/hop${n}.txt` } });
    });
    await expect(remote({ fetchImpl: impl }).readFile('a.txt')).rejects.toThrow(/redirect budget/);
  });

  it('detects a redirect cycle', async () => {
    const toB = new Response(null, { status: 302, headers: { Location: '/b.txt' } });
    const toA = new Response(null, { status: 302, headers: { Location: '/a.txt' } });
    const { impl } = fakeFetch((url) => (url.endsWith('/a.txt') ? toB : toA));
    await expect(remote({ fetchImpl: impl }).readFile('a.txt')).rejects.toThrow(/cycle/);
  });
});

describe('DavHttpRemote — auth headers', () => {
  it('sends Basic when configured', async () => {
    const { impl, calls } = fakeFetch(() => new Response('x', { status: 200 }));
    await remote({ fetchImpl: impl, auth: { kind: 'basic', value: basicAuthValue('me', 'pw') } }).readFile('a.txt');
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe(`Basic ${basicAuthValue('me', 'pw')}`);
  });

  it('sends a Bearer token when configured', async () => {
    const { impl, calls } = fakeFetch(() => new Response('x', { status: 200 }));
    await remote({ fetchImpl: impl, auth: { kind: 'bearer', token: 'tok' } }).readFile('a.txt');
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('sends no Authorization header when unauthenticated', async () => {
    const { impl, calls } = fakeFetch(() => new Response('x', { status: 200 }));
    await remote({ fetchImpl: impl }).readFile('a.txt');
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBeNull();
  });
});

describe('DavHttpRemote.list', () => {
  it('maps a multistatus onto inner paths', async () => {
    const body = multistatus([fileResponse('/remote.php/dav/files/me/a.txt'), fileResponse('/remote.php/dav/files/me/docs/b.txt')]);
    const { impl } = fakeFetch(() => new Response(body, { status: 207 }));
    const listing = await remote({ fetchImpl: impl }).list('');
    expect(listing.complete).toBe(true);
    expect(listing.entries.map((entry) => entry.path)).toEqual(['a.txt', 'docs/b.txt']);
  });

  it('scopes entries to the configured subdirectory', async () => {
    // The PROPFIND is already issued against `…/me/backup`, and `toInnerEntry`
    // strips that root — so the entries come back relative to the replication
    // root, which is the invariant the planner compares local paths against.
    // `DavVolumeRemote` rebases explicitly because a sibling bucket's DO listing
    // is whole-volume.
    const body = multistatus([fileResponse('/remote.php/dav/files/me/backup/a.txt'), fileResponse('/remote.php/dav/files/me/backup/deep/b.txt')]);
    const { impl } = fakeFetch(() => new Response(body, { status: 207 }));
    const listing = await remote({ fetchImpl: impl, remotePath: 'backup' }).list('');
    expect(listing.entries.map((entry) => entry.path)).toEqual(['a.txt', 'deep/b.txt']);
  });

  it('issues requests under the configured subdirectory', async () => {
    const { impl, calls } = fakeFetch(() => new Response(multistatus([]), { status: 207 }));
    await remote({ fetchImpl: impl, remotePath: 'backup' }).list('docs');
    expect(calls[0]?.url).toBe(`${BASE}/backup/docs`);
  });

  it('treats a 404 on the root as an empty listing, not a failure', async () => {
    // The configured subdirectory not existing yet is the normal state of a
    // freshly added target.
    const { impl } = fakeFetch(() => new Response(null, { status: 404 }));
    const listing = await remote({ fetchImpl: impl }).list('');
    expect(listing).toEqual({ entries: [], complete: true });
  });

  it('throws on 403 rather than reporting an empty collection', async () => {
    // Reporting this as empty is how one unreadable subdirectory turns into a
    // mass deletion: the absence would look like evidence.
    const { impl } = fakeFetch(() => new Response(null, { status: 403 }));
    await expect(remote({ fetchImpl: impl }).list('')).rejects.toThrow(RemoteUnavailableError);
  });

  it('throws when a 207 body is not a multistatus', async () => {
    const { impl } = fakeFetch(() => new Response('<html>login</html>', { status: 207 }));
    await expect(remote({ fetchImpl: impl }).list('')).rejects.toThrow(/not a usable multistatus/);
  });

  it('asks only for the four properties the comparison needs', async () => {
    // `allprop` on a large tree returns an order of magnitude more than the four
    // numbers the decision uses, and servers return whatever they feel like.
    const { impl, calls } = fakeFetch(() => new Response(multistatus([]), { status: 207 }));
    await remote({ fetchImpl: impl }).list('');
    const body = calls[0]?.init.body as string;
    expect(body).toContain('<d:getetag/>');
    expect(body).toContain('<d:getlastmodified/>');
    expect(body).toContain('<d:getcontentlength/>');
    expect(body).toContain('<d:resourcetype/>');
    expect(body).not.toContain('allprop');
  });
});

describe('DavHttpRemote — writes', () => {
  it('accepts 201 and 204 from PUT', async () => {
    for (const status of [201, 204]) {
      const { impl } = fakeFetch(() => new Response(null, { status }));
      await expect(remote({ fetchImpl: impl }).writeFile('a.txt', new Uint8Array([1]), { contentType: null, ifMatch: null })).resolves.toEqual({
        etag: null,
      });
    }
  });

  it('turns a 412 into an explicit precondition failure', async () => {
    // A human wrote the file between our read and our write. That must be
    // reported, not retried over the top of their edit.
    const { impl } = fakeFetch(() => new Response(null, { status: 412 }));
    await expect(remote({ fetchImpl: impl }).writeFile('a.txt', new Uint8Array([1]), { contentType: null, ifMatch: '"x"' })).rejects.toThrow(
      /If-Match/,
    );
  });

  it('sends If-Match only when a precondition was supplied', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const target = remote({ fetchImpl: impl });
    await target.writeFile('a.txt', new Uint8Array([1]), { contentType: null, ifMatch: '"v1"' });
    await target.writeFile('b.txt', new Uint8Array([1]), { contentType: null, ifMatch: null });
    expect(new Headers(calls[0]?.init.headers).get('If-Match')).toBe('"v1"');
    expect(new Headers(calls[1]?.init.headers).get('If-Match')).toBeNull();
  });

  it('treats 405 from MKCOL as success, because the collection already exists', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 405 }));
    await expect(remote({ fetchImpl: impl }).makeCollection('docs')).resolves.toBeUndefined();
  });

  it('surfaces a 409 from MKCOL rather than retrying', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 409 }));
    await expect(remote({ fetchImpl: impl }).makeCollection('a/b/c')).rejects.toThrow(RemoteUnavailableError);
  });
});

describe('DavHttpRemote.remove — recursive emulation', () => {
  it('empties a subtree before deleting it', async () => {
    // RFC 4918 §9.6.1 makes `Depth: infinity` optional and most servers refuse it,
    // so a recursive delete has to be built by hand — and a target that silently
    // refused would wedge the sweep.
    //
    // The fake is path-aware on purpose: it answers `PROPFIND` for the directory
    // and nothing for the file, which is what a real server does (the file's own
    // response is dropped as "the requested collection").
    const withChild = multistatus([fileResponse('/remote.php/dav/files/me/dir/a.txt')]);
    const { impl, calls } = fakeFetch((url, init) => {
      if (init.method !== 'PROPFIND') return new Response(null, { status: 204 });
      // The fake is path-aware on purpose: a real server answers a `PROPFIND` for a
      // file with that file alone, which `toInnerEntry` drops as "the requested
      // collection". Returning the directory's listing for every path would recurse
      // forever.
      return new Response(url.endsWith('/dir') ? withChild : multistatus([]), { status: 207 });
    });
    await remote({ fetchImpl: impl }).remove('dir', { ifMatch: null, recursive: true });
    const deletes = calls.filter((call) => call.init.method === 'DELETE').map((call) => call.url);
    expect(deletes).toEqual([`${BASE}/dir/a.txt`, `${BASE}/dir`]);
  });

  it('does not recurse indefinitely on a server that keeps reporting the same child', async () => {
    // A misbehaving target that answers every PROPFIND with the same child would
    // otherwise recurse without bound inside a Durable Object invocation.
    const { impl } = fakeFetch((_url, init) =>
      init.method === 'PROPFIND' ? new Response(multistatus([fileResponse('/remote.php/dav/files/me/dir/a.txt')]), { status: 207 }) : new Response(null, { status: 204 }),
    );
    await expect(remote({ fetchImpl: impl }).remove('dir', { ifMatch: null, recursive: true })).rejects.toThrow(RemoteUnavailableError);
  });

  it('issues a single DELETE when recursion is not requested', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await remote({ fetchImpl: impl }).remove('a.txt', { ifMatch: null, recursive: false });
    expect(calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1);
  });

  it('treats a 404 as success so a repeated pass is idempotent', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(remote({ fetchImpl: impl }).remove('a.txt', { ifMatch: null, recursive: false })).resolves.toBeUndefined();
  });
});

describe('DavHttpRemote.probe', () => {
  it('returns the advertised DAV classes', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 200, headers: { DAV: '1, 2, 3' } }));
    await expect(remote({ fetchImpl: impl }).probe()).resolves.toEqual({ davClasses: ['1', '2', '3'] });
  });

  it('reports a non-WebDAV target distinctly from an empty one', async () => {
    // A URL resolving to a login page is the commonest misconfiguration, and it
    // must not be reported as "the remote is empty".
    const { impl } = fakeFetch(() => new Response('<html>login</html>', { status: 200 }));
    await expect(remote({ fetchImpl: impl }).probe()).rejects.toThrow(/does not appear to be a WebDAV server/);
  });

  it('reports an unauthorized target', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 401 }));
    await expect(remote({ fetchImpl: impl }).probe()).rejects.toThrow(/OPTIONS/);
  });
});

describe('DavHttpRemote — construction', () => {
  it('refuses a URL the egress policy rejects, at construction time', () => {
    // Rejected before any request is made, so a misconfigured target cannot even
    // be probed.
    expect(() => remote({ baseUrl: 'http://127.0.0.1/' })).toThrow();
  });

  it('exposes the configured root for diagnostics', () => {
    expect(remote({ remotePath: 'backup' }).root).toBe('backup');
    expect(remote().root).toBe('');
  });
});
