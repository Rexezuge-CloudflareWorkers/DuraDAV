import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { innerPathOf } from '../apps/api/src/workers/routes/DavRoutes';

describe('innerPathOf', () => {
  it('drops exactly the two route segments', () => {
    expect(innerPathOf('https://h/alice/photos')).toBe('');
    expect(innerPathOf('https://h/alice/photos/')).toBe('');
    expect(innerPathOf('https://h/alice/photos/notes.txt')).toBe('notes.txt');
    expect(innerPathOf('https://h/alice/photos/dir/notes.txt')).toBe('dir/notes.txt');
    expect(innerPathOf('https://h/alice/photos/dir/')).toBe('dir');
  });

  it('handles a volume name that is not the only path segment', () => {
    // `owner`/`volume` are the FIRST two segments, whatever they contain.
    expect(innerPathOf('https://h/alice/my.photos/a/b.txt')).toBe('a/b.txt');
    expect(innerPathOf('https://h/alice/x_y/a/b.txt')).toBe('a/b.txt');
  });

  it('is unaffected by percent-encoding the owner or volume', () => {
    // The regression. Hono *decodes* `c.req.param()`, while `url.pathname` is
    // still encoded, so slicing on a base built from the params failed whenever a
    // client percent-encoded an unreserved character — which RFC 3986 §2.3
    // permits. `/%61lice/photos/notes.txt` is `alice`; the old comparison
    // produced `inner = ''` and the DO served the **volume root** in place of the
    // file: a `GET` returned the root's collection listing and a `PROPFIND`
    // returned the wrong multistatus. A wrong answer, not an error.
    expect(innerPathOf('https://h/%61lice/photos/notes.txt')).toBe('notes.txt');
    expect(innerPathOf('https://h/alice/photo%73/notes.txt')).toBe('notes.txt');
    expect(innerPathOf('https://h/%61lice/%70hotos/notes.txt')).toBe('notes.txt');
    // Including a space, which `isValidVolumeName` permits.
    expect(innerPathOf('https://h/alice/my%20photos/notes.txt')).toBe('notes.txt');
  });

  it('leaves the remainder encoded, as the DO decoder expects', () => {
    // `resolveInnerPath` runs `decodeSegments` on `X-Dav-Path`, so the front door
    // must not pre-decode — and pre-decoding is what would let `%2f` become a
    // real path separator before `isValidInnerPath` ever saw it.
    expect(innerPathOf('https://h/alice/photos/a%2Fb.txt')).toBe('a%2Fb.txt');
    expect(innerPathOf('https://h/alice/photos/my%20file.txt')).toBe('my%20file.txt');
    expect(innerPathOf('https://h/alice/photos/caf%C3%A9.txt')).toBe('caf%C3%A9.txt');
  });

  it('ignores the query string and fragment', () => {
    // They are not part of the resource path (§8.3). A query ending in `/` is
    // exactly what made the DO's own `request.url.endsWith('/')` check misfire.
    expect(innerPathOf('https://h/alice/photos/notes.txt?next=/')).toBe('notes.txt');
    expect(innerPathOf('https://h/alice/photos/notes.txt#frag')).toBe('notes.txt');
  });

  it('strips surrounding slashes, including an interior doubled one', () => {
    // `stripSlashes` trims the whole remainder, so the doubled separator at the
    // junction disappears along with a trailing one. Documented rather than
    // asserted as a requirement: the DO's `isValidInnerPath` is what rejects a
    // genuine interior empty segment (`a//b`), and this only affects the seam.
    expect(innerPathOf('https://h/alice/photos//notes.txt')).toBe('notes.txt');
    expect(innerPathOf('https://h/alice/photos/dir//notes.txt')).toBe('dir//notes.txt');
  });

  it('distinguishes a nested path from a sibling with a shared prefix', () => {
    // The bug a string-prefix test would introduce: `ab` is not under `a`.
    expect(innerPathOf('https://h/alice/ab/notes.txt')).toBe('notes.txt');
  });

  it('works against a real Hono route', () => {
    // Guards the assumption the fix rests on: the route matches exactly two
    // leading segments, so slicing them off is always correct regardless of how
    // the client encoded them.
    const app = new Hono();
    app.get('/:owner/:volume/*', (c) => c.json({ owner: c.req.param('owner'), volume: c.req.param('volume'), inner: innerPathOf(c.req.url) }));

    return Promise.all(
      [
        '/alice/photos/notes.txt',
        '/%61lice/photos/notes.txt',
        '/alice/my%20photos/dir/notes.txt',
      ].map(async (path) => {
        const body = (await (await app.request(`https://h${path}`)).json()) as { owner: string; volume: string; inner: string };
        expect(body.inner).toBe(path.endsWith('dir/notes.txt') ? 'dir/notes.txt' : 'notes.txt');
      }),
    );
  });
});