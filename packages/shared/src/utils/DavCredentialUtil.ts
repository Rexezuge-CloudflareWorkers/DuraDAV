import { CryptoUtil } from './CryptoUtil';

const CREDENTIAL_ANIMALS = [
  'alpaca',
  'badger',
  'beaver',
  'bobcat',
  'buffalo',
  'camel',
  'cheetah',
  'cougar',
  'coyote',
  'dolphin',
  'eagle',
  'falcon',
  'ferret',
  'fox',
  'gazelle',
  'giraffe',
  'gorilla',
  'hamster',
  'heron',
  'jaguar',
  'koala',
  'lemur',
  'leopard',
  'llama',
  'lynx',
  'meerkat',
  'moose',
  'otter',
  'panda',
  'panther',
  'penguin',
  'puma',
  'rabbit',
  'raccoon',
  'raven',
  'seal',
  'tiger',
  'walrus',
  'weasel',
  'zebra',
] as const;

const CREDENTIAL_ADJECTIVES = [
  'swift',
  'bright',
  'calm',
  'clever',
  'crisp',
  'daring',
  'eager',
  'frosty',
  'gentle',
  'glacial',
  'golden',
  'granite',
  'harbor',
  'iron',
  'jade',
  'keen',
  'lunar',
  'maple',
  'marble',
  'misty',
  'nimble',
  'noble',
  'onyx',
  'pebble',
  'pine',
  'quartz',
  'quiet',
  'rapid',
  'rocky',
  'sandy',
  'shady',
  'silky',
  'solar',
  'spruce',
  'stony',
  'sunny',
  'tidal',
  'timber',
  'velvet',
  'willow',
] as const;

/**
 * PBKDF2 work factor.
 *
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 600 000 iterations. Cloudflare
 * Workers CPU budget is 30 s of wall time per request with a much smaller
 * default CPU allowance, and this runs on the Basic-auth hot path (every
 * unauthenticated request), so 600 000 would price out ordinary clients. 100 000
 * keeps a single verification in the low milliseconds while remaining ~100x
 * more expensive to attack than the bare SHA-256 it replaces. Raise it as
 * hardware headroom allows; the count is stored per-hash, so existing rows stay
 * verifiable after a change.
 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = 'pbkdf2-sha256';
const PBKDF2_KEY_BYTES = 32;

/**
 * Ceiling on the iteration count read back out of a stored hash.
 *
 * `isSafeInteger` is not a bound: `Number.MAX_SAFE_INTEGER` passes it, so a
 * corrupt or hostile `dav_credentials` row could name a work factor that turns
 * one unauthenticated Basic request into a derivation measured in years. The
 * ceiling is generous enough that a future legitimate work-factor increase (even
 * 100x) still verifies, while turning an absurd value into an ordinary
 * authentication failure.
 */
const PBKDF2_MAX_ITERATIONS = 10_000_000;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  // `=` only ever appears as trailing base64 padding, so a linear replaceAll is
  // equivalent to a trailing-run regex here and has no backtracking.
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.codePointAt(i) ?? 0;
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    PBKDF2_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Constant-time compare.
 *
 * A timing oracle on a password hash is still an oracle: an attacker who can
 * measure how long the rejection takes recovers the digest byte by byte, which
 * is enough to verify a guessed password offline. Accumulating the XOR of every
 * pair and branching once at the end keeps the loop free of early exits.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyPbkdf2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  // `['pbkdf2-sha256', iterations, salt, hash]`
  if (parts.length !== 4) return false;
  const [, iterationText, saltText, hashText] = parts as [string, string, string, string];
  // Bounded on both ends: `isSafeInteger` rejects `1e300`, which is not even a
  // safe integer, but *accepts* `Number.MAX_SAFE_INTEGER` — so the upper clamp
  // is what actually stops a corrupt row from becoming a CPU-exhaustion vector
  // on the unauthenticated hot path.
  const iterations = Number(iterationText);
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > PBKDF2_MAX_ITERATIONS) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(saltText);
    expected = fromBase64Url(hashText);
  } catch {
    // Not valid base64url: a corrupt row, not a wrong password.
    return false;
  }
  // A zero-length salt or hash is a corrupt row. Short-circuit so `pbkdf2` is
  // never handed one (an empty salt is a real, if useless, derivation).
  return salt.length > 0 && expected.length > 0 && timingSafeEqual(await pbkdf2(password, salt, iterations), expected);
}

function slugifyVolume(volumeName: string): string {
  const lower = volumeName.toLowerCase();
  let out = '';
  let lastDash = false;
  for (const ch of lower) {
    const alnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (alnum) {
      out += ch;
      lastDash = false;
    } else if (!lastDash && out.length > 0) {
      out += '-';
      lastDash = true;
    }
  }
  while (out.endsWith('-')) out = out.slice(0, -1);
  if (out === '') return 'volume';
  let truncated = out.slice(0, 16);
  while (truncated.endsWith('-')) truncated = truncated.slice(0, -1);
  return truncated || 'volume';
}

/* eslint-disable unicorn/class-reference-in-static-methods -- explicit class ref keeps stubbing simple */
class DavCredentialUtil {
  public static generatePassword(): string {
    return `ddav_${CryptoUtil.randomBase64Url(32)}`;
  }

  public static generateUsername(volumeName: string): string {
    const slug = slugifyVolume(volumeName);
    const adjective = CREDENTIAL_ADJECTIVES[DavCredentialUtil.randomInteger(CREDENTIAL_ADJECTIVES.length)];
    const animal = CREDENTIAL_ANIMALS[DavCredentialUtil.randomInteger(CREDENTIAL_ANIMALS.length)];
    const digits = DavCredentialUtil.randomInteger(10_000).toString().padStart(4, '0');
    return `${slug}-${adjective}-${animal}-${digits}`;
  }

  /**
   * Hash a WebDAV Basic password.
   *
   * Why not a bare SHA-256: these passwords authenticate the whole WebDAV
   * surface, and a bare digest is unsalted. A single D1 leak is then trivially
   * reversible with a precomputed table, and every user who picked the same
   * password shares a hash, so one lookup cracks all of them.
   *
   * The encoding is self-describing so it can be rotated later:
   * `pbkdf2-sha256$<iterations>$<saltBase64Url>$<hashBase64Url>`.
   */
  public static async hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(derived)}`;
  }

  /**
   * Verify a password against a stored hash, accepting the legacy format.
   *
   * Returns `true`/`false`; returns `true` for `needsRehash` when a legacy
   * digest matched, so the caller can upgrade the row in place. A stored value
   * that is neither format is a hard failure, not a silent `false`: a
   * malformed hash means the row is unusable, and reporting "wrong password"
   * would send the user into a password-reset loop that cannot succeed.
   */
  public static async verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    if (stored.startsWith(PBKDF2_PREFIX)) return { ok: await verifyPbkdf2(password, stored), needsRehash: false };
    if (/^[\da-f]{64}$/iu.test(stored)) {
      // Legacy unsalted SHA-256. Still accepted so existing credentials keep
      // working; the caller's `needsRehash` upgrades them on first successful
      // use.
      const matches = (await CryptoUtil.sha256Hex(password)) === stored.toLowerCase();
      return { ok: matches, needsRehash: matches };
    }
    throw new Error('verifyPassword: unrecognized stored hash format');
  }

  public static getPrefix(password: string): string {
    return password.slice(0, 10);
  }

  public static getLastFour(password: string): string {
    return password.slice(-4);
  }

  private static randomInteger(maxExclusive: number): number {
    const values = new Uint32Array(1);
    const limit = Math.floor(0xff_ff_ff_ff / maxExclusive) * maxExclusive;
    do {
      crypto.getRandomValues(values);
    } while (values[0] >= limit);
    return values[0] % maxExclusive;
  }
}
/* eslint-enable unicorn/class-reference-in-static-methods */

export { DavCredentialUtil, CREDENTIAL_ANIMALS, CREDENTIAL_ADJECTIVES, slugifyVolume };
