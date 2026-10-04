/**
 * AES-GCM envelope for values that must be recoverable.
 *
 * The bucket credentials in `dav_credentials` are *verified*, never decrypted:
 * they are one-way hashes, so this module has no equivalent for them. A
 * replication target is the opposite case — the Worker has to present the
 * remote password on every sync, so the secret is stored in a form it can read
 * back, and that obliges it to be encrypted.
 *
 * Key material comes from the `REPLICATION_ENCRYPTION_KEY` secret as base64 of
 * exactly 32 bytes. A missing or wrong-sized key throws
 * `ReplicationKeyError` rather than returning plaintext: the alternative — a
 * helper that quietly passes the value through when it cannot encrypt — would
 * store the remote password in the clear on exactly the deployments that forgot
 * to configure a key, and nothing would report it.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;

class ReplicationKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicationKeyError';
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = (binary.codePointAt(i) ?? 0) & 0xff;
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function importKey(encodedKey: string | undefined | null): Promise<CryptoKey> {
  if (typeof encodedKey !== 'string' || encodedKey.trim() === '') {
    throw new ReplicationKeyError('REPLICATION_ENCRYPTION_KEY is not configured; remote replication credentials cannot be stored');
  }
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(encodedKey.trim());
  } catch {
    throw new ReplicationKeyError('REPLICATION_ENCRYPTION_KEY is not valid base64');
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new ReplicationKeyError(`REPLICATION_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${raw.byteLength}`);
  }
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch {
    throw new ReplicationKeyError('REPLICATION_ENCRYPTION_KEY could not be imported as an AES-GCM key');
  }
}

type EncryptedEnvelope = {
  ciphertext: string;
  iv: string;
};

/**
 * Encrypt one secret. The IV is random per call and returned alongside the
 * ciphertext so the caller can store the pair — reusing an IV under one key
 * destroys GCM's security guarantees outright, which is why this is not
 * internal to the ciphertext.
 */
async function encryptReplicationSecret(plaintext: string, encodedKey: string | undefined | null): Promise<EncryptedEnvelope> {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bytesToBase64(new Uint8Array(sealed)), iv: bytesToBase64(iv) };
}

/**
 * Decrypt one envelope.
 *
 * Throws on a wrong key or a tampered ciphertext rather than returning
 * something. A replication row that cannot be decrypted must report `failed`;
 * the alternative is skipping authentication and letting the remote answer
 * `401`, which reads as a target problem instead of a key problem.
 */
async function decryptReplicationSecret(envelope: EncryptedEnvelope, encodedKey: string | undefined | null): Promise<string> {
  const key = await importKey(encodedKey);
  try {
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(opened);
  } catch {
    throw new ReplicationKeyError('stored replication credential could not be decrypted with REPLICATION_ENCRYPTION_KEY');
  }
}

/**
Generate a fresh base64 key, for `wrangler secret put REPLICATION_ENCRYPTION_KEY`.
*/
function generateReplicationKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export { encryptReplicationSecret, decryptReplicationSecret, generateReplicationKey, ReplicationKeyError, KEY_BYTES };
export type { EncryptedEnvelope };
