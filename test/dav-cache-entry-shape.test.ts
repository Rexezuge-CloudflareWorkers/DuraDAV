import { describe, expect, it } from 'vitest';
import { asFileEntry, asPropfindEntry } from '../apps/api/src/workers/routes/DavReadServing';

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
  const bytes = new Uint8Array([104, 105]);

  it('accepts a well-formed entry', () => {
    expect(asFileEntry({ etag: '"e"', contentType: 'text/plain', bytes })).toEqual({ etag: '"e"', contentType: 'text/plain', bytes });
  });

  it('accepts an empty file, which is a legitimate zero-byte body', () => {
    const empty = new Uint8Array(0);
    expect(asFileEntry({ etag: '"e"', contentType: 'text/plain', bytes: empty })).toEqual({
      etag: '"e"',
      contentType: 'text/plain',
      bytes: empty,
    });
  });

  it('defaults a missing contentType to null rather than failing', () => {
    expect(asFileEntry({ etag: '"e"', bytes })).toEqual({ etag: '"e"', contentType: null, bytes });
    expect(asFileEntry({ etag: '"e"', contentType: 42, bytes })).toEqual({ etag: '"e"', contentType: null, bytes });
  });

  it('treats a missing or mistyped body as a miss, not as an empty file', () => {
    // This is the regression: `entry.b64 ?? ''` decoded to zero bytes and
    // answered `200 Content-Length: 0` for a file that exists.
    expect(asFileEntry({ etag: '"e"' })).toBeNull();
    expect(asFileEntry({ etag: '"e"', bytes: null })).toBeNull();
    expect(asFileEntry({ etag: '"e"', bytes: 42 })).toBeNull();
    expect(asFileEntry({ etag: '"e"', bytes: 'aGk=' })).toBeNull();
    expect(asFileEntry({ etag: '"e"', b64: 'aGk=' })).toBeNull();
  });

  it('treats a missing or empty etag as a miss', () => {
    expect(asFileEntry({ bytes })).toBeNull();
    expect(asFileEntry({ etag: '', bytes })).toBeNull();
  });

  it('treats a non-object as a miss', () => {
    for (const raw of [null, undefined, 'string', 42, []]) {
      expect(asFileEntry(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('passes high bytes through without corrupting them', () => {
    // Byte values above 0x7F are the interesting case for the old base64 path;
    // binary entries never encode, so they round-trip by identity.
    const high = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const entry = asFileEntry({ etag: '"e"', bytes: high });
    expect(entry).not.toBeNull();
    expect([...(entry?.bytes ?? [])]).toEqual([...high]);
  });

  it('wraps an ArrayBuffer body rather than missing', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const entry = asFileEntry({ etag: '"e"', bytes: bytes.buffer });
    expect(entry).not.toBeNull();
    expect([...(entry?.bytes ?? [])]).toEqual([1, 2, 3]);
  });
});
