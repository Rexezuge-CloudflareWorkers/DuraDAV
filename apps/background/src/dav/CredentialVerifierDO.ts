import { DurableObject } from 'cloudflare:workers';
import { DavCredentialUtil, passwordFingerprint } from '@durable-dav/shared/utils';

/**
 * Why this class exists: a Worker on the Cloudflare **Free** plan has a 10 ms
 * CPU budget per invocation, and one PBKDF2-SHA256 derivation at the shipped
 * 100 000 iterations costs roughly 10-20 ms. Every Basic-authenticated DAV
 * request therefore ran one derivation, overran the budget, and Cloudflare killed
 * the invocation — which reaches the client as an HTTP **503** with
 * `outcome: "exceededCpu"` in the logs, not as any status this codebase emits.
 * It reproduced on plain reads (`GET` with a `Range`, `PROPFIND Depth: 1`)
 * because reads are all a read-only credential can do, and it read as a
 * read-only-credentials bug when it was a CPU bug affecting every credential.
 *
 * Why a Durable Object: a DO invocation gets 30 s of CPU by default (raisable to
 * 5 minutes with `limits.cpu_ms`) *regardless of account plan*, which is
 * Cloudflare's own documented remedy for a Worker hitting its CPU ceiling.
 * Moving the derivation here puts it somewhere it fits.
 *
 * Why not route every request through it: a DO serializes per object, so one
 * verifier handling all traffic would add a hop per request and become the new
 * bottleneck. It is consulted only on a *cache miss*, and only after the
 * front-door memo misses, so steady-state cost is a memo hit and no hop at all.
 *
 * Reached only through a stub binding, never a public route: it accepts a
 * presented password, so exposing it would put an unauthenticated password
 * verifier on the open internet. `fetch` rejects anything that is not a
 * well-formed internal verify call.
 */

const VERIFY_PATH = '/verify';
const DEFAULT_TTL_SECONDS = 60;
const MAX_CACHE_ENTRIES = 200;

interface VerifyRequestBody {
  username?: string;
  password?: string;
  passwordHash?: string;
}

interface VerifyResponseBody {
  ok: boolean;
  needsRehash: boolean;
  /**
   * A PBKDF2 hash for the same password, or `null` when the stored row is
   * already current. Present so the caller can upgrade a legacy unsalted-SHA256
   * row without paying a *second* derivation: the bytes needed to build the new
   * hash are already in hand here.
   */
  upgradedHash: string | null;
}

interface CacheEntry {
  passwordHash: string;
  expiresAt: number;
}

/**
 * Bounded TTL cache of *successful* verifications, keyed by credential
 * (`username` + password fingerprint) and valued with the stored hash it was
 * verified against.
 *
 * Three deliberate properties:
 *
 * 1. **Failures are never cached.** A wrong password must always cost a real
 *    derivation, or an attacker gets a free verification oracle and the
 *    brute-force cost this class exists to pay disappears.
 * 2. **The key carries a password fingerprint**, so a cached verdict answers
 *    only for the exact password presented. Keying on `username` alone would
 *    accept *any* password for a recently-used username — a total
 *    authentication bypass.
 * 3. **The value is checked on read.** A rotation or `PATCH` changes the stored
 *    hash, so a verdict issued for the previous one no longer matches and the
 *    entry is discarded.
 */
class VerificationCache {
  private readonly entries = new Map<string, CacheEntry>();

  public constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  public get(key: string, passwordHash: string, now: number): boolean {
    const hit = this.entries.get(key);
    if (!hit) return false;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return hit.passwordHash === passwordHash;
  }

  public set(key: string, passwordHash: string, now: number): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      // Oldest-first via Map insertion order. This cache is a performance aid,
      // so evicting costs one derivation, never correctness.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { passwordHash, expiresAt: now + this.ttlMs });
  }

  public deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  

  public get size(): number {
    return this.entries.size;
  }
}

class CredentialVerifierDO extends DurableObject<Env> {
  private readonly cache: VerificationCache;
  private readonly inflight = new Map<string, Promise<VerifyResponseBody>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Narrowed locally rather than read off `Env`: `Env` is generated from the
    // committed wrangler template, and an optional var that is absent from every
    // deployment would otherwise be a type error there. Same shape as
    // `DavVolumeWorker`'s `AppConfiguration.fromEnv(env)`.
    const configured = Number((env as { CREDENTIAL_MEMO_TTL_SECONDS?: string }).CREDENTIAL_MEMO_TTL_SECONDS);
    const ttlSeconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_SECONDS;
    this.cache = new VerificationCache(ttlSeconds * 1000, MAX_CACHE_ENTRIES);
  }

  public override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== VERIFY_PATH || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as VerifyRequestBody;
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const passwordHash = typeof body.passwordHash === 'string' ? body.passwordHash : '';
    return !username || !password || !passwordHash ? new Response('Bad Request', { status: 400 }) : Response.json(await this.verify(username, password, passwordHash));
  }

  private async verify(username: string, password: string, passwordHash: string): Promise<VerifyResponseBody> {
    const key = `${username}:${await passwordFingerprint(password)}`;
    const now = Date.now();
    if (this.cache.get(key, passwordHash, now)) {
      return { ok: true, needsRehash: false, upgradedHash: null };
    }
    // One in-flight derivation per credential. The object serializes its
    // handlers, so without this a cold-start burst of eight parallel requests
    // runs eight PBKDF2 derivations where one would do.
    const pending = this.inflight.get(key);
    if (pending) {
      const settled = await pending.catch(() => null);
      if (settled?.ok) {
        return ({ ok: this.cache.get(key, passwordHash, Date.now()) ? true : false, needsRehash: false, upgradedHash: null });
      }
    }
    const run = this.derive(key, password, passwordHash);
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async derive(key: string, password: string, passwordHash: string): Promise<VerifyResponseBody> {
    const { ok, needsRehash } = await DavCredentialUtil.verifyPassword(password, passwordHash).catch(() => ({
      ok: false,
      needsRehash: false,
    }));
    if (!ok) return { ok: false, needsRehash: false, upgradedHash: null };
    // The derivation is already done, so the rehash is free here — this is the
    // second derivation the front door used to pay on every legacy credential's
    // first use.
    const upgradedHash = needsRehash ? await DavCredentialUtil.hashPassword(password).catch(() => null) : null;
    this.cache.set(key, passwordHash, Date.now());
    return { ok: true, needsRehash, upgradedHash };
  }

  /**
   * Drop cached verdicts for one credential.
   *
   * Lets revocation (delete, password rotation) skip the TTL. Best-effort by
   * design: the front door never blocks a DAV request on it, and the TTL bounds
   * the worst case if it never arrives.
   */
  public invalidate(username: string): void {
    this.cache.deletePrefix(`${username}:`);
  }

  public cacheSize(): number {
    return this.cache.size;
  }
}

export { CredentialVerifierDO, VerificationCache };
export type { VerifyRequestBody, VerifyResponseBody, CacheEntry };
// Re-exported so the shard constants stay discoverable next to the class that
// serves them; the single definition is in `shared` (see `CredentialShardUtil`).
export {   VERIFY_PATH, DEFAULT_TTL_SECONDS, MAX_CACHE_ENTRIES };
export {credentialShardOf, CREDENTIAL_SHARD_COUNT} from '@durable-dav/shared/utils';