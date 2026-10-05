import { describe, expect, it } from 'vitest';
import { bytesToBase64, base64ToBytes } from '@durable-dav/shared/utils';

describe('base64 codec', () => {
  // Known vectors, including every padding length and both alphabet edges.
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ];

  for (const [plain, encoded] of vectors) {
    it(`encodes ${JSON.stringify(plain)}`, () => {
      expect(bytesToBase64(new TextEncoder().encode(plain))).toBe(encoded);
    });
  }

  it('round-trips arbitrary bytes at every length modulo 3', () => {
    for (let length = 0; length < 200; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + length) % 256;
      const round = base64ToBytes(bytesToBase64(bytes));
      expect(Array.from(round), `length ${length}`).toEqual(Array.from(bytes));
    }
  });

  it('agrees with the platform encoder for a large buffer', () => {
    // Guards the hand-rolled 3-byte table against an indexing mistake at scale.
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 251) % 256;
    const viaTable = bytesToBase64(bytes);
    const viaPlatform = btoa(String.fromCodePoint(...Array.from(bytes)));
    expect(viaTable).toBe(viaPlatform);
    expect(Array.from(base64ToBytes(viaTable))).toEqual(Array.from(bytes));
  });

  it('handles the full byte range including 0x00 and 0xff', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('encodes past the old chunk boundary, and past the spread argument limit', () => {
    // Why this implementation exists. The `String.fromCodePoint(...subarray)` form
    // it replaced chunked at 8192 bytes — and a variadic spread that size is
    // already at the edge of the engine's argument limit, while each chunk
    // allocated a full binary string plus 2× as UTF-16. This asserts the encoder
    // agrees with the platform at a size where that form breaks, which is exactly
    // the `GET`/`PROPFIND` cache-write path in `DavReadCache` that used to run it.
    const bytes = new Uint8Array(32_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 97 + 13) % 256;
    const viaTable = bytesToBase64(bytes);

    // Chunked the way the old implementation did, so the comparison is valid at a
    // size where a single spread would throw a RangeError.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCodePoint(...bytes.subarray(i, i + 8192));
    }
    expect(viaTable).toBe(btoa(binary));
    expect(Array.from(base64ToBytes(viaTable))).toEqual(Array.from(bytes));
  });

  it('round-trips a payload larger than one chunk', () => {
    const bytes = new Uint8Array(20_000);
    crypto.getRandomValues(bytes);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
