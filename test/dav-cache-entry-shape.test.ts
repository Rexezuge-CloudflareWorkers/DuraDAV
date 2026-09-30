import { describe, expect, it } from 'vitest';
import { asFileEntry, asPropfindEntry } from '../apps/api/src/workers/routes/DavReadServing';
import { bytesToBase64, base64ToBytes } from '../apps/api/src/workers/routes/DavReadCache';

/**
 * The fail-closed boundary between "whatever is in KV" and "what we serve".
 *
 * The bug: both readers used `?? ''` on the body field, so an entry that did
 * not have the expected shape produced `200 Content-Length: 0` for a file the
 * client could see listed, and an **empty** 207 multistatus for a collection.
 * The second is the worse one — an empty multistatus is indistinguishable from
 * a genuinely empty folder, so a cache quirk reads as data loss.
 *
 * The contract is therefore: anything unrecognised is a *miss*, never a
 * zero-length success.
 */

describe('asPropfindEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(asPropfindEntry({ etag: 'W/"1"', body: '<multistatus/>' })).toEqual({ etag: 'W/"1"', body: '<multistatus/>' });
  });

  it('accepts an empty body, which is a legitimate empty multistatus', () => {
    // Distinguishable from a miss precisely because the *entry* was well-formed
    // and the caller chose to cache an empty listing.
    expect(asPropfindEntry({ etag: 'W/"1"', body: '' })).toEqual({ etag: 'W/"1"', body: '' });
  });

  it('treats a missing or mistyped body as a miss', () => {
    expect(asPropfindEntry({ etag: 'W/"1"' })).toBeNull();
    expect(asPropfindEntry({ etag: 'W/"1"', body: 42 })).toBeNull();
    expect(asPropfindEntry({ etag: 'W/"1"', body: null })).toBeNull();
    expect(asPropfindEntry({ etag: 'W/"1"', body: { xml: 'x' } })).toBeNull();
  });

  it('treats a missing or empty etag as a miss', () => {
    // Without an etag there is no `If-None-Match` to answer and no way to tell a
    // fresh entry from a stale one.
    expect(asPropfindEntry({ body: '<x/>' })).toBeNull();
    expect(asPropfindEntry({ etag: '', body: '<x/>' })).toBeNull();
    expect(asPropfindEntry({ etag: 7, body: '<x/>' })).toBeNull();
  });

  it('treats a non-object as a miss', () => {
    for (const raw of [null, undefined, 'string', 42, true, [], [['a']]]) {
      expect(asPropfindEntry(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('asFileEntry', () => {
  const b64 = bytesToBase64(new Uint8Array([104, 105]));

  it('accepts a well-formed entry', () => {
    expect(asFileEntry({ etag: '"e"', contentType: 'text/plain', b64 })).toEqual({ etag: '"e"', contentType: 'text/plain', b64 });
  });

  it('defaults a missing contentType to null rather than failing', () => {
    expect(asFileEntry({ etag: '"e"', b64 })).toEqual({ etag: '"e"', contentType: null, b64 });
    expect(asFileEntry({ etag: '"e"', contentType: 42, b64 })).toEqual({ etag: '"e"', contentType: null, b64 });
  });

  it('treats a missing or mistyped body as a miss, not as an empty file', () => {
    // This is the regression: `entry.b64 ?? ''` decoded to zero bytes and
    // answered `200 Content-Length: 0` for a file that exists.
    expect(asFileEntry({ etag: '"e"' })).toBeNull();
    expect(asFileEntry({ etag: '"e"', b64: null })).toBeNull();
    expect(asFileEntry({ etag: '"e"', b64: 42 })).toBeNull();
  });

  it('treats undecodable base64 as a miss instead of throwing', () => {
    expect(asFileEntry({ etag: '"e"', b64: '!!!not base64!!!' })).toBeNull();
  });

  it('treats a missing or empty etag as a miss', () => {
    expect(asFileEntry({ b64 })).toBeNull();
    expect(asFileEntry({ etag: '', b64 })).toBeNull();
  });

  it('treats a non-object as a miss', () => {
    for (const raw of [null, undefined, 'string', 42, []]) {
      expect(asFileEntry(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('round-trips a real payload without corrupting it', () => {
    // Byte values above 0x7F are the interesting case: a `charCodeAt`/UTF-8
    // round trip through `btoa` would mangle them, which is why `b64` is
    // re-encoded from the *decoded bytes* rather than passed through as text.
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const entry = asFileEntry({ etag: '"e"', b64: bytesToBase64(bytes) });
    expect(entry).not.toBeNull();
    expect(entry?.b64).toBe(bytesToBase64(bytes));
    const decoded = base64ToBytes(entry?.b64 ?? '');
    expect([...decoded]).toEqual([...bytes]);
  });
});
