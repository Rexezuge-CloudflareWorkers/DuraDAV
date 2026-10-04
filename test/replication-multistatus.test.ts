import { describe, expect, it } from 'vitest';
import { parseMultiStatus, decodePathname, normalizeEtag, isSuccessStatus } from '@durable-dav/webdav';

/**
 * The 207 response parser, against bodies shaped like real servers'.
 *
 * This is the only place an arbitrary third-party WebDAV server's answer is
 * interpreted, so the cases that matter are the malformed and the unusual rather
 * than the textbook one: a weak ETag, a missing `getlastmodified`, a percent-
 * encoded href, an HTML error page served with `200`.
 */

const BASE = 'https://dav.example.com/remote.php/dav/files/me/backup';

function parse(body: string, baseUrl = BASE) {
  return parseMultiStatus(body, { baseUrl });
}

const MULTISTATUS_OPEN = '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">';
const MULTISTATUS_CLOSE = '</D:multistatus>';

describe('parseMultiStatus', () => {
  it('reads a file entry with a strong ETag', () => {
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/notes.txt</D:href>` +
      `<D:propstat><D:prop><D:resourcetype/><D:getetag>"abc123"</D:getetag>` +
      `<D:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</D:getlastmodified>` +
      `<D:getcontentlength>1234</D:getcontentlength><D:getcontenttype>text/plain</D:getcontenttype></D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    const parsed = parse(body);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({
      isCollection: false,
      etag: 'abc123',
      size: 1234,
      contentType: 'text/plain',
      propsComplete: true,
    });
    expect(parsed?.[0]?.lastModified).toBe(Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'));
  });

  it('identifies a collection from resourcetype', () => {
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/docs/</D:href>` +
      `<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)?.[0]?.isCollection).toBe(true);
  });

  it('does not treat a trailing slash as a collection when resourcetype is absent', () => {
    // Defaulting to `true` on the href shape would make a server that omits the
    // property receive `MKCOL` over its own files.
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/weird/</D:href>` +
      `<D:propstat><D:prop><D:getetag>"x"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status>` +
      `</D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)?.[0]?.isCollection).toBe(false);
  });

  it('keeps the weak marker on a weak ETag', () => {
    // Dropping `W/` would let a weak validator compare equal to a strong one, and
    // the planner treats a strong match as proof the two sides hold the same bytes.
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/a.txt</D:href>` +
      `<D:propstat><D:prop><D:getetag>W/"weak-1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status>` +
      `</D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)?.[0]?.etag).toBe('W/weak-1');
  });

  it('merges properties across several 2xx propstats', () => {
    // Splitting a response's properties across propstat blocks is conforming and
    // common; taking only the first block loses half the resource.
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/a.txt</D:href>` +
      `<D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
      `<D:propstat><D:prop><D:getcontentlength>7</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
      `<D:propstat><D:prop><D:displayname>a</D:displayname></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>` +
      `</D:response>${MULTISTATUS_CLOSE}`;
    const entry = parse(body)?.[0];
    expect(entry?.etag).toBe('e');
    expect(entry?.size).toBe(7);
  });

  it('marks propsComplete false when no 2xx propstat is present', () => {
    // "Listed, but every property 404s" is a real shape and must stay
    // distinguishable from "not listed at all" — the difference between a
    // resource and a deletion.
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/a.txt</D:href>` +
      `<D:propstat><D:prop><D:displayname>a</D:displayname></D:prop><D:status>HTTP/1.1 404 Not Found</D:status>` +
      `</D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    const entry = parse(body)?.[0];
    expect(entry).toBeDefined();
    expect(entry?.propsComplete).toBe(false);
    expect(entry?.etag).toBeNull();
  });

  it('accepts a propstat with no status element', () => {
    // RFC 4918 §14.22 requires it, but real servers omit it; treating the omitted
    // case as a failure would drop every property such a server does return.
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/a.txt</D:href>` +
      `<D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop></D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)?.[0]?.etag).toBe('e');
  });

  it('percent-decodes the href', () => {
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/a%20b%2Bc.txt</D:href>` +
      `<D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status>` +
      `</D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)?.[0]?.pathname).toBe('/remote.php/dav/files/me/backup/a b+c.txt');
  });

  it('resolves a relative href against the request URL', () => {
    // Some proxies answer with relative hrefs; assuming absolute ones mismaps
    // every path in the tree.
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>a.txt</D:href>` +
      `<D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status>` +
      `</D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body, `${BASE}/`)?.[0]?.pathname).toBe('/remote.php/dav/files/me/backup/a.txt');
  });

  it('returns null for a non-multistatus body, so a login page is never read as empty', () => {
    // The single most common misconfiguration: a URL that resolves to an HTML
    // login form answering 200. `[]` here would report "the remote is empty",
    // which is the input to a deletion decision.
    expect(parse('<html><body>Sign in</body></html>')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('{"error":"unauthorized"}')).toBeNull();
  });

  it('returns null for malformed XML rather than a partial listing', () => {
    expect(parse(`${MULTISTATUS_OPEN}<D:response><D:href>/a</D:href>`)).toBeNull();
  });

  it('skips a response with no usable href instead of throwing', () => {
    const body = `${MULTISTATUS_OPEN}<D:response><D:status>HTTP/1.1 200 OK</D:status></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)).toEqual([]);
  });

  it('parses several responses in one body', () => {
    const entry = (name: string) =>
      `<D:response><D:href>/remote.php/dav/files/me/backup/${name}</D:href>` +
      `<D:propstat><D:prop><D:getetag>"${name}"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    const parsed = parse(`${MULTISTATUS_OPEN}${entry('a.txt')}${entry('b.txt')}${MULTISTATUS_CLOSE}`);
    expect(parsed?.map((resource) => resource.etag)).toEqual(['a.txt', 'b.txt']);
  });

  it('leaves an unparseable content length null rather than NaN', () => {
    const body = `${MULTISTATUS_OPEN}<D:response><D:href>/remote.php/dav/files/me/backup/a.txt</D:href>` +
      `<D:propstat><D:prop><D:getcontentlength>many</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status>` +
      `</D:propstat></D:response>${MULTISTATUS_CLOSE}`;
    expect(parse(body)?.[0]?.size).toBeNull();
  });
});

describe('helpers', () => {
  it('decodePathname decodes per segment so an encoded slash stays a character', () => {
    // A whole-string decode would turn `%2F` into a separator and move the resource
    // to a different path — the exact confusion this guards.
    expect(decodePathname('/a%2Fb/c')).toBe('/a/b/c');
  });

  it('decodePathname keeps a malformed escape verbatim instead of throwing', () => {
    // One bad href from the remote must not abort the parse of a good listing.
    expect(decodePathname('/a%ZZ/b')).toBe('/a%ZZ/b');
  });

  it('normalizeEtag strips quotes and rejects empties', () => {
    expect(normalizeEtag('"abc"')).toBe('abc');
    expect(normalizeEtag('abc')).toBe('abc');
    expect(normalizeEtag('""')).toBeNull();
    expect(normalizeEtag(' '.repeat(3))).toBeNull();
    expect(normalizeEtag(null)).toBeNull();
  });

  it('isSuccessStatus accepts 2xx and treats an omitted status as success', () => {
    expect(isSuccessStatus('HTTP/1.1 200 OK')).toBe(true);
    expect(isSuccessStatus('HTTP/1.1 207 Multi-Status')).toBe(true);
    expect(isSuccessStatus('HTTP/1.1 404 Not Found')).toBe(false);
    expect(isSuccessStatus('HTTP/1.1 403 Forbidden')).toBe(false);
    expect(isSuccessStatus('')).toBe(true);
    expect(isSuccessStatus('garbage')).toBe(false);
  });
});
