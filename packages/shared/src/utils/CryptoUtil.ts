class CryptoUtility {
  /**
   * SHA-256 of a string, hex-encoded.
   *
   * Encoded as UTF-8 first. For bytes you already hold, prefer `sha256HexOfBytes`
   * — this overload is the reason a byte payload used to be laundered through
   * `String.fromCodePoint` into a binary string and back, allocating roughly 2×
   * the input as UTF-16 on the way.
   */
  public static async sha256Hex(value: string): Promise<string> {
    return this.sha256HexOfBytes(new TextEncoder().encode(value));
  }

  /**
   * SHA-256 of raw bytes, hex-encoded.
   *
   * The hash covers exactly these bytes. This matters where the digest is
   * compared between two sides: any intermediate encoding is a place for the two
   * to disagree for a reason that has nothing to do with the content.
   */
  public static async sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
    const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return this.toHex(new Uint8Array(digest));
  }

  private static toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte: number): string => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * base64url of `bytes`.
   *
   * Delegates to the shared codec rather than rebuilding the binary string here:
   * this was a fourth copy of the `String.fromCodePoint` + `btoa` form that
   * `Base64.ts` exists to replace, differing only in the `-`/`_` and padding
   * transform. The alphabet differs; the byte accumulation does not.
   */
  private static toBase64Url(bytes: Uint8Array): string {
    // `Uint8Array#toBase64` is not guaranteed across Workers runtimes, so the
    // URL-safe transform is applied to the standard alphabet.
    return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/={0,2}$/, '');
  }

  public static randomBase64Url(byteLength: number): string {
    return this.toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
  }
}

import { bytesToBase64 } from './Base64';

export { CryptoUtility as CryptoUtil };
