import { DavCredentialUtil, credentialShardOf, passwordFingerprint } from '@durable-dav/shared/utils';
import { lookupCredentialMemo, rememberCredential } from './credentialMemo';

/**
 * Front door for password verification: the tiering, in one place.
 *
 * Cheapest first:
 *
 * 1. **Isolate memo** (`credentialMemo.ts`) — a hit costs one SHA-256 and no
 *    subrequest. Handles the steady state for a client already talking to this
 *    isolate, which is the overwhelmingly common case for a media client
 *    streaming ranged `GET`s.
 * 2. **Verifier DO** — one hop, where the CPU budget is 30 s rather than the
 *    Free plan's 10 ms. Handles a cold or different isolate.
 * 3. **Local derivation** — last resort, and the only tier that runs PBKDF2 in
 *    the Worker. Reached when the DO binding is absent (tests, a partially
 *    migrated deployment) or the hop fails, which makes the change safe to land
 *    before the DO exists. On the Free plan this is also the tier that 503s, so
 *    the DO binding is what actually fixes the reported bug.
 *
 * Every tier returns the same shape, including `upgradedHash` for the legacy
 * unsalted-SHA256 upgrade, so a caller cannot tell which one answered.
 *
 * `passwordHash` is passed in rather than looked up here on purpose: the caller
 * owns the D1 read and must make its authorization decision against a freshly
 * read row. Only the derivation is ever reused.
 */

interface VerifyOutcome {
  ok: boolean;
  needsRehash: boolean;
  /**
   * A current-format hash for the same password, or `null` when the stored row
   * needs no upgrade. Lets the caller rehash without a second derivation.
   */
  upgradedHash: string | null;
}

const REJECTED: VerifyOutcome = { ok: false, needsRehash: false, upgradedHash: null };

/**
 * Ask the verifier DO, tolerating its absence.
 *
 * A missing binding, a malformed reply, or a transport failure all fall back to
 * a local derivation rather than failing the request: an auth-path fault must not
 * lock a bucket owner out of their own bucket. The cost of falling back is the
 * CPU overrun this change exists to remove, which is strictly better than a 401.
 */
async function verifyViaDo(env: Env | undefined, username: string, password: string, passwordHash: string): Promise<VerifyOutcome | null> {
  // `env` is optional and `DAV_AUTH` may be absent (a test, or a deployment that
  // has not added the binding yet). Either way the answer is "no DO", which
  // routes to a local derivation — never a failure. Guarding `env` itself too:
  // an absent binding must not throw while looking for it.
  const namespace = (env as { DAV_AUTH?: DurableObjectNamespace } | undefined)?.DAV_AUTH;
  if (!namespace) return null;
  try {
    const stub = namespace.get(namespace.idFromName(String(credentialShardOf(username))));
    const response = await stub.fetch('https://dav-auth.internal/verify', {
      method: 'POST',
      body: JSON.stringify({ username, password, passwordHash }),
    });
    if (!response.ok) return null;
    // `unknown`, not a cast: the reply crosses a trust boundary — the DO may be
    // a different version than the Worker that asked it — so every field is
    // validated before use rather than assumed. A shape change must degrade to
    // "no DO answer" (a local derivation), never to a wrong verdict.
    const parsed: unknown = await response.json().catch(() => null);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as { ok: unknown; needsRehash?: unknown; upgradedHash?: unknown };
    if (typeof candidate.ok !== 'boolean') return null;
    return {
      ok: candidate.ok,
      needsRehash: candidate.needsRehash === true,
      upgradedHash: typeof candidate.upgradedHash === 'string' ? candidate.upgradedHash : null,
    };
  } catch {
    return null;
  }
}

async function verifyLocally(password: string, passwordHash: string): Promise<VerifyOutcome> {
  const { ok, needsRehash } = await DavCredentialUtil.verifyPassword(password, passwordHash).catch(() => ({
    ok: false,
    needsRehash: false,
  }));
  if (!ok) return REJECTED;
  return {
    ok: true,
    needsRehash,
    // Best-effort. The legacy digest still verifies, so a failure here only
    // defers the upgrade to the next successful use — it must not turn a valid
    // credential into a 500. The DO tier returns the hash it already computed
    // instead, so this path is the no-binding fallback rather than the norm.
    upgradedHash: needsRehash ? await DavCredentialUtil.hashPassword(password).catch(() => null) : null,
  };
}

/**
 * Verify one presented password against one stored hash.
 *
 * Only *successful* verifications are memoized, so a wrong password always pays
 * a real derivation and the brute-force cost is unchanged.
 */
async function verifyCredential(env: Env | undefined, username: string, password: string, passwordHash: string): Promise<VerifyOutcome> {
  const fingerprint = await passwordFingerprint(password);
  if (lookupCredentialMemo(username, fingerprint, passwordHash)) {
    return { ok: true, needsRehash: false, upgradedHash: null };
  }
  const outcome = (await verifyViaDo(env, username, password, passwordHash)) ?? (await verifyLocally(password, passwordHash));
  if (outcome.ok) rememberCredential(username, fingerprint, passwordHash);
  return outcome;
}

export { verifyCredential, verifyViaDo };
export type { VerifyOutcome };