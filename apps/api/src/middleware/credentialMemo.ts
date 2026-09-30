/**
 * Per-isolate memo of successful password verifications.
 *
 * ## Why
 *
 * A Worker on the Cloudflare Free plan has a 10 ms CPU budget per invocation,
 * and one PBKDF2-SHA256 derivation at the shipped 100 000 iterations costs
 * roughly 10-20 ms. Verifying on every Basic-authenticated DAV request therefore
 * overran the budget on *every* request, Cloudflare killed the invocation
 * (`outcome: "exceededCpu"`, client sees 503), and the symptom looked like a
 * read-only-credentials bug because reads are all a read-only credential can
 * attempt.
 *
 * Tiering lives in `credentialVerifier.ts`: this memo is the first (and
 * cheapest) tier, consulted before the verifier DO. It is first because it is
 * free — a DO hop on the hot path would add latency to every chunk of every
 * stream to solve a problem most requests never reach the DO for.
 *
 * ## What is and is not cached
 *
 * Cached: the *derivation* — "this exact password verified against this exact
 * stored hash". Not cached: the authorization decision. The caller still reads
 * the volume row and the credential row from D1 on every request, so volume
 * binding, expiry, `read_only`, and revocation all still take effect
 * immediately. Only PBKDF2 is skipped.
 *
 * ## Failure mode this must not have
 *
 * Keying on `username` alone would accept **any** password for a recently-used
 * username — a total authentication bypass. The key therefore includes a
 * fingerprint of the presented password (`passwordFingerprint`, one
 * unsalted SHA-256: a memo key, never a credential), and the value records the
 * stored hash so a rotation invalidates it. A wrong password produces a
 * different key, so it misses and pays a full derivation. Failures are never
 * remembered, which preserves today's brute-force cost and avoids handing an
 * attacker a free verification oracle.
 *
 * The residual timing signal — a hit returns faster than a miss, so
 * correct-vs-incorrect is observable by latency — discloses nothing new, because
 * the response already distinguishes them (200/207 vs 401).
 *
 * ## Eviction
 *
 * Bounded by count with oldest-first eviction and by a TTL, mirroring
 * `rateLimit.ts`. Both are correctness-neutral performance aids: dropping an
 * entry costs one derivation, never a wrong answer.
 */

const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 256;

interface Entry {
  passwordHash: string;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

/**
Injectable clock; tests drive TTL expiry without sleeping.
*/
const clock: { now: () => number } = { now: () => Date.now() };

/**
 * Whether this password was already verified against this stored hash.
 *
 * The TTL check runs before the hash comparison, and a stale or superseded entry
 * is removed on the way out so it cannot be re-read by a later request.
 */
function lookupCredentialMemo(username: string, fingerprint: string, passwordHash: string): boolean {
  const key = `${username}:${fingerprint}`;
  const hit = entries.get(key);
  if (!hit) return false;
  if (hit.expiresAt <= clock.now()) {
    entries.delete(key);
    return false;
  }
  if (hit.passwordHash !== passwordHash) {
    // Rotation or a PATCH changed the row: this verdict was issued against a
    // hash that no longer exists.
    entries.delete(key);
    return false;
  }
  return true;
}

function rememberCredential(username: string, fingerprint: string, passwordHash: string): void {
  const key = `${username}:${fingerprint}`;
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(key, { passwordHash, expiresAt: clock.now() + DEFAULT_TTL_MS });
}

/**
 * Drop every memoized verdict for one credential.
 *
 * Lets a password rotation or revocation take effect without waiting out the
 * TTL. Best-effort by design; the TTL bounds the worst case if it never arrives.
 */
function forgetCredential(username: string): void {
  const prefix = `${username}:`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

function resetCredentialMemoForTests(): void {
  entries.clear();
  clock.now = () => Date.now();
}

function setCredentialMemoClockForTests(next: () => number): void {
  clock.now = next;
}

function credentialMemoSizeForTests(): number {
  return entries.size;
}

export {
  lookupCredentialMemo,
  rememberCredential,
  forgetCredential,
  resetCredentialMemoForTests,
  setCredentialMemoClockForTests,
  credentialMemoSizeForTests,
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
};