// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError, extractErrorMessage } from '~/lib/api';
import { copyEntry, createDirectory, deleteEntry, downloadUrl, listDirectory, moveEntry, uploadFile } from '~/services/davClient';

/**
 * `davClient` — the browser plane's WebDAV transport.
 *
 * The invariants worth pinning are all about *not* losing or not destroying
 * something:
 *
 * - `entryUrl` refuses to build a URL outside the volume base, so a `..`
 *   segment cannot escape even if a caller skips `cleanPath`.
 * - MOVE/COPY send `Overwrite: F` by default. With `T` the server removes the
 *   destination *before* creating the source, so a rename onto an occupied name
 *   deleted the destination with no prompt.
 * - Errors are parsed by the same helper as the rest of the SPA. The local copy
 *   knew only the AWS envelope, so a legacy `{error, message}` body lost its
 *   localized wording.
 */
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>/alice/photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/alice/photos/a.txt</href><propstat><prop><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;

describe('entryUrl', () => {
  it('builds a browser-plane URL inside the volume base', () => {
    expect(downloadUrl('alice', 'photos', 'docs/a.txt')).toBe('/user/volumes/alice/photos/files/docs/a.txt');
  });

  it('percent-encodes each segment but not the separators', () => {
    expect(downloadUrl('alice', 'photos', 'a b/c#d.txt')).toBe('/user/volumes/alice/photos/files/a%20b/c%23d.txt');
  });

  it('refuses a path that would escape the volume base', () => {
    // Defence in depth: a caller that skips `cleanPath` must still not emit a
    // request outside the bucket.
    for (const attempt of ['../other/x', 'a/../../other/x', '..']) {
      const url = downloadUrl('alice', 'photos', attempt);
      expect(url.startsWith('/user/volumes/alice/photos/files/')).toBe(true);
      expect(url).not.toContain('..');
    }
  });

  it('encodes the owner and volume so a slash in either cannot forge a path', () => {
    expect(downloadUrl('a/b', 'c/d', 'x')).toBe('/user/volumes/a%2Fb/c%2Fd/files/x');
  });

  it('returns the collection URL for an empty path', () => {
    expect(downloadUrl('alice', 'photos', '')).toBe('/user/volumes/alice/photos/files/');
  });
});

describe('listDirectory', () => {
  it('parses the multistatus and strips the volume base from hrefs', async () => {
    fetchMock.mockResolvedValue(new Response(MULTISTATUS, { status: 207 }));
    const listing = await listDirectory('alice', 'photos', '');
    expect(listing.entries).toHaveLength(1);
    expect(listing.entries[0].name).toBe('a.txt');
    // The parsed path is fed straight back into the next request, so it must be
    // volume-relative.
    expect(listing.entries[0].path).toBe('a.txt');
  });

  it('sends Depth: 1 and the paging query', async () => {
    fetchMock.mockResolvedValue(new Response(MULTISTATUS, { status: 207 }));
    await listDirectory('alice', 'photos', '', { page: 2, limit: 25 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PROPFIND');
    expect(init.headers.Depth).toBe('1');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=25');
  });

  it('reports an unpaged listing rather than assuming completeness', async () => {
    // An absent `X-Dav-Page-Count` means the server does not page, so the body
    // is the complete listing. The caller must be able to tell the two apart.
    fetchMock.mockResolvedValue(new Response(MULTISTATUS, { status: 207 }));
    const listing = await listDirectory('alice', 'photos', '');
    expect(listing.paged).toBe(false);
    expect(listing.total).toBeNull();
  });

  it('reads the page headers the server actually served', async () => {
    fetchMock.mockResolvedValue(
      new Response(MULTISTATUS, {
        status: 207,
        headers: { 'X-Dav-Page-Count': '3', 'X-Dav-Page': '1', 'X-Dav-Page-Limit': '1' },
      }),
    );
    const listing = await listDirectory('alice', 'photos', '', { page: 99, limit: 1 });
    expect(listing).toMatchObject({ paged: true, total: 3, page: 1, limit: 1 });
  });

  it('never derives the limit from the entry count', async () => {
    // An empty page would otherwise report `limit: 1`, which renders as
    // "1 entry" rather than "none".
    fetchMock.mockResolvedValue(new Response(MULTISTATUS, { status: 207, headers: { 'X-Dav-Page-Count': '0' } }));
    const listing = await listDirectory('alice', 'photos', '', { page: 1, limit: 50 });
    expect(listing.limit).toBe(50);
  });

  it('throws rather than returning [] for a body that is not a multistatus', async () => {
    // `VolumeFileList` renders `entries.length === 0` as the positive assertion
    // "Empty Folder", so an unparseable body answered as `[]` states a
    // falsehood.
    fetchMock.mockResolvedValue(new Response('<html>login</html>', { status: 207 }));
    await expect(listDirectory('alice', 'photos', '')).rejects.toThrow();
  });
});

describe('error parsing', () => {
  it('reads the AWS envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Exception: { Type: 'ForbiddenError', Message: 'Not yours.' } }, 403));
    const error = await deleteEntry('alice', 'photos', 'x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).message).toBe('Not yours.');
    expect((error as BackendError).errorType).toBe('ForbiddenError');
    expect((error as BackendError).status).toBe(403);
  });

  it('reads the legacy {error, message} shape, which the local copy lost', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'BadRequest', message: 'Legacy wording.' }, 400));
    const error = await deleteEntry('alice', 'photos', 'x').catch((caught: unknown) => caught);
    expect((error as BackendError).message).toBe('Legacy wording.');
    expect((error as BackendError).errorType).toBe('BadRequest');
  });

  it('surfaces a plain-text WebDAV error, truncated', async () => {
    fetchMock.mockResolvedValue(new Response('Locked', { status: 423 }));
    const error = await deleteEntry('alice', 'photos', 'x').catch((caught: unknown) => caught);
    expect((error as BackendError).message).toBe('Locked');
    expect((error as BackendError).status).toBe(423);
  });

  it('never lets an unbounded body become the error message', () => {
    const long = 'x'.repeat(5000);
    expect(extractErrorMessage(long, 500).message.length).toBeLessThanOrEqual(501);
  });

  it('falls back to the status when the body is empty', () => {
    expect(extractErrorMessage('', 502)).toEqual({ message: 'HTTP 502', type: null });
  });
});

describe('mutating helpers refuse to overwrite by default', () => {
  it('sends Overwrite: F on MOVE, so a collision is a 412 rather than a silent delete', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await moveEntry('alice', 'photos', 'a.txt', 'b.txt');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('MOVE');
    expect(init.headers.Overwrite).toBe('F');
  });

  it('sends Overwrite: F on COPY', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await copyEntry('alice', 'photos', 'a.txt', 'a.txt-copy');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Overwrite).toBe('F');
  });

  it('sends Overwrite: T only when the caller has explicit consent', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await moveEntry('alice', 'photos', 'a.txt', 'b.txt', true);
    expect(fetchMock.mock.calls[0][1].headers.Overwrite).toBe('T');
  });

  it('sends an absolute Destination built inside the volume base', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await moveEntry('alice', 'photos', 'a.txt', 'b.txt');
    expect(fetchMock.mock.calls[0][1].headers.Destination).toContain('/user/volumes/alice/photos/files/b.txt');
  });

  it('propagates a 412 so the caller can prompt', async () => {
    fetchMock.mockResolvedValue(new Response('Precondition Failed', { status: 412 }));
    await expect(moveEntry('alice', 'photos', 'a.txt', 'b.txt')).rejects.toMatchObject({ status: 412 });
  });
});

describe('mutating helpers', () => {
  it('MKCOL creates a collection', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await createDirectory('alice', 'photos', 'newdir');
    expect(fetchMock.mock.calls[0][1].method).toBe('MKCOL');
  });

  it('PUT uploads with the file type, defaulting to octet-stream', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await uploadFile('alice', 'photos', 'a.txt', { type: '', size: 1 } as File);
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/octet-stream');
  });

  it('PUT keeps an explicit content type', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await uploadFile('alice', 'photos', 'a.txt', { type: 'text/csv', size: 1 } as File);
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('text/csv');
  });

  it('DELETE issues a DELETE and drains the body', async () => {
    // An unread body holds the connection open, which a multi-file upload plus
    // MKCOL/DELETE/MOVE could exhaust.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteEntry('alice', 'photos', 'a.txt');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});