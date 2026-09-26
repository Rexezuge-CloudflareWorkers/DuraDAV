import { describe, expect, it } from 'vitest';
import { isValidInnerPath, resolveInnerPath, resolveDavBases, stripBase } from '../apps/background/src/dav/DavContext';
import { parseRangeHeader } from '../apps/background/src/dav/RangeParser';
import { resolveDestination } from '../apps/api/src/workers/routes/davDestination';
import { readDavHrefPrefixMode, toDavHrefPrefixMode } from '@durable-dav/shared/constants';

describe('DavContext path helpers', () => {
  it('prefers X-Dav-Path header over URL parsing', () => {
    const req = new Request('https://example.com/alice/photos/a/b', { headers: { 'X-Dav-Path': 'a/b' } });
    expect(resolveInnerPath(req, new URL(req.url), '/alice/photos')).toBe('a/b');
  });

  it('strips the /owner/volume base from direct DO URLs', () => {
    const req = new Request('https://example.com/alice/photos/a/b');
    expect(resolveInnerPath(req, new URL(req.url), '/alice/photos')).toBe('a/b');
  });

  it('rejects traversal segments', () => {
    expect(isValidInnerPath('')).toBe(true);
    expect(isValidInnerPath('a/b')).toBe(true);
    expect(isValidInnerPath('a/../b')).toBe(false);
    expect(isValidInnerPath('..')).toBe(false);
    expect(isValidInnerPath('a//b')).toBe(false);
  });

  it('maps Destination full paths back to volume-relative paths', () => {
    expect(stripBase('alice/photos/a/b', '/alice/photos')).toBe('a/b');
    expect(stripBase('alice/photos', '/alice/photos')).toBe('');
    expect(stripBase('bob/other/a', '/alice/photos')).toBeNull();
  });
});

/**
 * The href mode must not be able to leak into addressing.
 *
 * `resolveDavBases` is the only place the two prefixes are derived, so a bug
 * here would either break a `root`-mode bucket's own request addressing or
 * silently give a `base`-mode bucket root-anchored hrefs — the exact interop
 * regression RFC 4918 §8.3 exists to prevent.
 */
describe('resolveDavBases', () => {
  it('anchors hrefs at the volume base by default', () => {
    expect(resolveDavBases('/alice/photos', null)).toEqual({ pathBase: '/alice/photos', hrefBase: '/alice/photos' });
  });

  it('keeps request addressing intact when hrefs are root-anchored', () => {
    // The half that matters: `pathBase` must not follow `hrefBase` to '', or
    // `resolveInnerPath` would read `/alice/photos/docs` as a volume-relative
    // path and address `alice/photos/docs` inside the bucket.
    expect(resolveDavBases('/alice/photos', 'root')).toEqual({ pathBase: '/alice/photos', hrefBase: '' });
  });

  it('falls back to the conforming base for an absent or unrecognised mode', () => {
    // An unexpected value can only arrive through version skew. Answering with
    // the shape every existing client already works with beats failing the
    // request or silently flipping a bucket's addressing.
    for (const mode of [null, undefined, '', 'ROOT', 'Base', 'base ', 'true', '0']) {
      expect(resolveDavBases('/alice/photos', mode).hrefBase).toBe('/alice/photos');
    }
  });

  it('is case-sensitive, so a shouted header cannot smuggle root mode', () => {
    expect(resolveDavBases('/alice/photos', 'ROOT').hrefBase).toBe('/alice/photos');
  });
});

describe('href prefix mode coercion', () => {
  it('defaults a row without the column to the conforming mode', () => {
    // Migration 0003 added the column; rows written before it have no such
    // field at all, and a bucket must not fail every DAV request over that.
    expect(readDavHrefPrefixMode(undefined)).toBe('base');
    expect(readDavHrefPrefixMode(null)).toBe('base');
    expect(readDavHrefPrefixMode('')).toBe('base');
  });

  it('honours an explicit root', () => {
    expect(readDavHrefPrefixMode('root')).toBe('root');
    expect(readDavHrefPrefixMode('base')).toBe('base');
  });

  it('rejects an unknown mode for untrusted input rather than coercing it', () => {
    // Strict parse is what backs the 400 on a bad PATCH; coercing would either
    // hit the column CHECK (a 500) or store a mode the server cannot honour.
    expect(toDavHrefPrefixMode('root')).toBe('root');
    expect(toDavHrefPrefixMode('base')).toBe('base');
    for (const bad of ['ROOT', 'root ', '', null, undefined, 1, true, {}, []]) {
      expect(toDavHrefPrefixMode(bad)).toBeNull();
    }
  });
});

/**
 * `Destination` canonicalisation.
 *
 * The load-bearing case is the last block: in root mode a single-segment
 * destination is a *legal* root-level file, which is exactly the shape the
 * `%2e%2e` escape collapses into. That is why the front door resolves this and
 * the DO never sees two destination shapes.
 */
describe('resolveDestination', () => {
  const requestUrl = 'https://example.com/alice/photos/dir/file.txt';
  const pathBase = '/alice/photos';

  it('leaves a base-prefixed destination canonical', () => {
    const res = resolveDestination('https://example.com/alice/photos/other.txt', requestUrl, pathBase, 'base');
    expect(res).toEqual({ ok: true, destination: 'https://example.com/alice/photos/other.txt' });
  });

  it('maps the volume root to a trailing-slash destination', () => {
    expect(resolveDestination('https://example.com/alice/photos', requestUrl, pathBase, 'base')).toEqual({
      ok: true,
      destination: 'https://example.com/alice/photos/',
    });
  });

  it('maps a browser-plane destination onto the DAV base', () => {
    const res = resolveDestination('https://example.com/user/volumes/alice/photos/files/docs/a.txt', requestUrl, pathBase, 'base');
    expect(res).toEqual({ ok: true, destination: 'https://example.com/alice/photos/docs/a.txt' });
  });

  it('preserves percent-encoding instead of decoding and re-encoding', () => {
    const res = resolveDestination('https://example.com/alice/photos/my%20folder/a%2Bb.txt', requestUrl, pathBase, 'base');
    expect(res).toEqual({ ok: true, destination: 'https://example.com/alice/photos/my%20folder/a%2Bb.txt' });
  });

  it('matches the base case-insensitively, as volume keys are lowercased', () => {
    expect(resolveDestination('https://example.com/ALICE/PHOTOS/x.txt', requestUrl, pathBase, 'base')).toEqual({
      ok: true,
      destination: 'https://example.com/alice/photos/x.txt',
    });
  });

  it('rejects a cross-origin destination on both planes', () => {
    for (const mode of ['base', 'root'] as const) {
      expect(resolveDestination('https://evil.example.net/steal', requestUrl, pathBase, mode)).toMatchObject({
        ok: false,
        reason: 'cross-origin',
      });
    }
  });

  it('reports an absent header without treating it as an error the caller must raise', () => {
    expect(resolveDestination(null, requestUrl, pathBase, 'base')).toMatchObject({ ok: false, reason: 'absent' });
    expect(resolveDestination('', requestUrl, pathBase, 'base')).toMatchObject({ ok: false, reason: 'absent' });
  });

  it('refuses a root-anchored destination in base mode', () => {
    // In base mode the server advertised `/alice/photos/x.txt`, so `/x.txt`
    // names something outside the volume. Accepting it would be a cross-bucket
    // write by exactly the ambiguity `stripBase` was tightened to remove.
    expect(resolveDestination('https://example.com/x.txt', requestUrl, pathBase, 'base')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('accepts a root-anchored destination in root mode and re-attaches the base', () => {
    // The reason the front door does this: a root-mode client echoes back the
    // hrefs it was given, and the DO's `stripBase` cannot tell `/etc` (a legal
    // root-level file) from a normalised traversal escape.
    expect(resolveDestination('https://example.com/docs/a.txt', requestUrl, pathBase, 'root')).toEqual({
      ok: true,
      destination: 'https://example.com/alice/photos/docs/a.txt',
    });
    expect(resolveDestination('https://example.com/etc', requestUrl, pathBase, 'root')).toEqual({
      ok: true,
      destination: 'https://example.com/alice/photos/etc',
    });
  });

  it('rejects a dot-segment destination in root mode, in every encoding', () => {
    // The escape this whole module exists to keep closed. `new URL()` collapses
    // each of these *before* the resolved path can be inspected, so the check
    // has to run on the raw header.
    for (const dest of [
      'https://example.com/alice/photos/%2e%2e/%2e%2e/etc',
      'https://example.com/%2e%2e/%2e%2e/etc',
      'https://example.com/%2E%2E/etc',
      'https://example.com/.%2e/etc',
      'https://example.com/alice/photos/../etc',
      'https://example.com/alice/photos/./etc',
    ]) {
      for (const mode of ['base', 'root'] as const) {
        expect(resolveDestination(dest, requestUrl, pathBase, mode), `${dest} (${mode})`).toMatchObject({
          ok: false,
          reason: 'invalid',
        });
      }
    }
  });

  it('treats a relative destination that climbs out as a root-level file in root mode', () => {
    // Resolved against the request URL, the parser collapses this to `/etc`
    // before it can be inspected, so it is indistinguishable from a client
    // legitimately naming the root-level `etc`. Accepting it is correct, and
    // safe, because root mode presents the volume root as `/` — every path in
    // that namespace *is* inside the volume, so there is nothing to escape to.
    // In base mode the same header names something outside the volume, and the
    // same rejection the DO's `stripBase` performs applies.
    expect(resolveDestination('../../../etc', requestUrl, pathBase, 'root')).toEqual({
      ok: true,
      destination: 'https://example.com/alice/photos/etc',
    });
    expect(resolveDestination('../../../etc', requestUrl, pathBase, 'base')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('still allows a legitimate name that merely contains dots', () => {
    // Only `.` and `..` are dot-segments; the URL parser removes nothing else,
    // and `isValidInnerPath` permits these, so they must stay addressable.
    for (const name of ['my..name.txt', '...', '.hidden', 'a.b.c']) {
      expect(resolveDestination(`https://example.com/alice/photos/${name}`, requestUrl, pathBase, 'root'), name).toEqual({
        ok: true,
        destination: `https://example.com/alice/photos/${name}`,
      });
    }
  });

  it('can only ever produce a destination inside the volume, in either mode', () => {
    // The invariant that makes root mode safe to enable at all: the canonical
    // form is rebuilt from `pathBase`, so no client input — base-prefixed,
    // root-anchored, cross-volume, or climbing — can steer a COPY/MOVE at
    // another bucket or off the volume entirely.
    const inputs = [
      'https://example.com/alice/photos/x.txt',
      'https://example.com/x.txt',
      'https://example.com/bob/other/x.txt',
      'https://example.com/alice/photos/../../bob/other/x.txt',
      '../../../x.txt',
      '/x.txt',
      'x.txt',
    ];
    for (const mode of ['base', 'root'] as const) {
      for (const input of inputs) {
        const res = resolveDestination(input, requestUrl, pathBase, mode);
        if (!res.ok) continue;
        expect(res.destination, `${input} (${mode})`).toMatch(/^https:\/\/example\.com\/alice\/photos(\/|$)/);
      }
    }
  });
});

describe('parseRangeHeader', () => {
  it('returns full body when no Range header', () => {
    expect(parseRangeHeader(null, 100)).toMatchObject({ offset: 0, length: undefined, status: 200 });
  });

  it('parses start-end ranges', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toMatchObject({ offset: 10, length: 10, status: 206 });
  });

  it('parses open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=90-', 100)).toMatchObject({ offset: 90, length: 10, status: 206 });
    expect(parseRangeHeader('bytes=-10', 100)).toMatchObject({ offset: 90, length: 10, status: 206 });
  });

  it('ignores a malformed Range header but reports 416 for an unsatisfiable one', () => {
    // Malformed → ignore the header entirely (RFC 7233 §4.2), serve 200.
    expect(parseRangeHeader('bytes=banana', 100).status).toBe(200);
    // Syntactically valid but past the end → 416 with `bytes */size`
    // (RFC 7233 §4.4), not a silent full-body 200.
    expect(parseRangeHeader('bytes=200-300', 100)).toMatchObject({ status: 416, contentRange: 'bytes */100' });
    expect(parseRangeHeader('bytes=-0', 100).status).toBe(416);
    // Inverted range.
    expect(parseRangeHeader('bytes=50-10', 100).status).toBe(416);
  });

  it('ignores multi-range and does not mis-serve the first range only', () => {
    // Serving only `0-1` for `bytes=0-1,5-6` would be silent data loss.
    expect(parseRangeHeader('bytes=0-1,5-6', 100)).toMatchObject({ status: 200, length: undefined });
  });

  it('anchors the range syntax', () => {
    // The old unanchored regex matched inside `notbytes=0-5` and tolerated junk.
    expect(parseRangeHeader('notbytes=0-5', 100).status).toBe(200);
    expect(parseRangeHeader('bytes=0-5junk', 100).status).toBe(200);
    expect(parseRangeHeader('  bytes=0-5  ', 100)).toMatchObject({ status: 206, offset: 0, length: 6 });
    expect(parseRangeHeader('BYTES=0-5', 100)).toMatchObject({ status: 206, offset: 0, length: 6 });
  });
});
