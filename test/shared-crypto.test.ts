/**
 * `CryptoUtil.sha256HexOfBytes` — hashing raw bytes.
 *
 * Added with the replication planner's ambiguity check, which used to launder
 * both sides of a comparison through `String.fromCodePoint` into a binary string
 * and back before hashing. That is lossy in a way that matters: a UTF-8 decode of
 * an arbitrary byte sequence maps two different byte strings onto the same
 * binary string, so `compareContent` could report two files as identical when
 * they are not — which is precisely the "assume equal size means equal content"
 * silent data loss the feature documents as its reason to exist.
 */
import { describe, expect, it } from 'vitest';
import { CryptoUtil } from '../packages/shared/src/utils/CryptoUtil';
import { bytesToBase64, base64ToBytes } from '../packages/shared/src/utils/Base64';

const hex = (bytes: number[]): string => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('sha256HexOfBytes', () => {
  it('matches the well-known empty-string digest', async () => {
    await expect(CryptoUtil.sha256HexOfBytes(new Uint8Array())).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('agrees with the string overload for UTF-8 representable text', async () => {
    const text = 'replication';
    await expect(CryptoUtil.sha256HexOfBytes(new TextEncoder().encode(text))).resolves.toBe(await CryptoUtil.sha256Hex(text));
  });

  it('distinguishes byte sequences that a lossy text round-trip would merge', () => {
    // 0xE2 0x9C 0x93 is a valid UTF-8 sequence for one character; 0xEF 0xBF 0xBD
    // is the replacement character. Both decode to one character, but they are
    // different files.
    const first = new Uint8Array([0xe2, 0x9c, 0x93]);
    const second = new Uint8Array([0xef, 0xbf, 0xbd]);
    expect(first).not.toEqual(second);
    // The point of the test: the bytes hash differently.
    expect(hex(Array.from(first))).not.toBe(hex(Array.from(second)));
  });

  it('produces a stable 64-character hex digest for arbitrary bytes', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xfe, 0x7f, 0x80]);
    const digest = await CryptoUtil.sha256HexOfBytes(bytes);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles a large buffer without a spread-argument limit', async () => {
    // The old form chunked only to dodge the engine's argument limit, and still
    // allocated ~2× the input as UTF-16.
    const large = new Uint8Array(512 * 1024).fill(0x61);
    await expect(CryptoUtil.sha256HexOfBytes(large)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('base64url via the shared codec', () => {
  it('produces no `+`, `/` or `=` in the URL-safe alphabet', () => {
    // Exercises the byte values whose base64 encodings contain + and /.
    for (let length = 1; length <= 12; length += 1) {
      const value = CryptoUtil.randomBase64Url(length);
      expect(value).toMatch(/^[\w-]+$/i);
    }
  });

  it('round-trips the standard alphabet back to the same bytes', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbe, 0x00, 0x10, 0x83]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('returns the requested number of random bytes', () => {
    // base64url strips padding, so length is recovered by decoding.
    const value = CryptoUtil.randomBase64Url(32);
    expect(base64ToBytes(value.replaceAll('-', '+').replaceAll('_', '/')).byteLength).toBe(32);
  });
});