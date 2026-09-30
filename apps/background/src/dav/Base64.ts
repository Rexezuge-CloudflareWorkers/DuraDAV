const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encode bytes without a spread or an intermediate binary string.
 *
 * The previous implementation built a JS string with
 * `String.fromCodePoint(...bytes.subarray(i, i + 8192))` and then `btoa`-ed it.
 * That allocated roughly 2x the input as UTF-16 (up to 100 MB for a 50 MB
 * file) on top of the buffer itself and the base64 result, and the variadic
 * spread approaches the engine's argument limit. A direct 3-byte-to-4-char
 * table is allocation-light and has no argument limit.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  const remainder = len % 3;
  const limit = len - remainder;
  for (let i = 0; i < limit; i += 3) {
    const triple = bytes[i] * 65_536 + bytes[i + 1] * 256 + bytes[i + 2];
    out +=
      BASE64_ALPHABET[(triple >> 18) & 63] +
      BASE64_ALPHABET[(triple >> 12) & 63] +
      BASE64_ALPHABET[(triple >> 6) & 63] +
      BASE64_ALPHABET[triple & 63];
  }
  if (remainder === 1) {
    const value = bytes[limit];
    out += `${BASE64_ALPHABET[value >> 2]}${BASE64_ALPHABET[(value << 4) & 63]}==`;
  } else if (remainder === 2) {
    const pair = (bytes[limit] << 8) | bytes[limit + 1];
    out += `${BASE64_ALPHABET[pair >> 10]}${BASE64_ALPHABET[(pair >> 4) & 63]}${BASE64_ALPHABET[(pair << 2) & 63]}=`;
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = (binary.codePointAt(i) ?? 0) & 0xff;
  return out;
}

export { bytesToBase64, base64ToBytes };
