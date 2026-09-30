import { CryptoUtil } from './CryptoUtil';

/**
 * A cheap, deterministic tag for a presented password.
 *
 * **Not a credential, and not a secret.** It is one unsalted SHA-256, so it is
 * exactly as crackable as the legacy unsalted digest it is sometimes confused
 * with — a rainbow table recovers it instantly, and two users who chose the same
 * password share a value. It exists to be a memo *key* and nothing else. Any
 * code that treats it as a password hash is wrong.
 *
 * ## Why it exists
 *
 * Password verification is memoized so a repeated request does not pay a PBKDF2
 * derivation again (see the Auth section of the root `AGENTS.md`). The memo must
 * distinguish "this exact password was already verified against this stored
 * hash" from "someone presented a different password for this username".
 * Keying on `username` alone would accept **any** password for a recently-used
 * username — a total authentication bypass.
 *
 * So the lookup key includes this fingerprint: it makes the key specific to the
 * password actually presented, at the cost of one SHA-256 (microseconds)
 * instead of one PBKDF2 derivation (milliseconds, and on the Workers Free plan
 * more than the entire CPU budget).
 */
async function passwordFingerprint(password: string): Promise<string> {
  return CryptoUtil.sha256Hex(password);
}

export { passwordFingerprint };