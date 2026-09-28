import type { Context, Next } from 'hono';

type RateLimitContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string; AuthenticatedUserId?: string } }>;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function clientIp(c: RateLimitContext): string {
  // Trust order is deliberate: Cloudflare sets CF-Connecting-IP and it cannot
  // be spoofed by clients. X-Forwarded-For is NOT trusted by default because
  // it is client-controlled and lets attackers rotate buckets at will.
  // Local dev without CF headers shares the `unknown` bucket (fail-closed
  // grouping rather than per-spoofed-IP isolation).
  const cfIp = c.req.header('CF-Connecting-IP')?.trim();
  return cfIp || 'unknown';
}

function getRateLimitBucketCountForTests(): number {
  return buckets.size;
}

function evictOldestBucket(): void {
  let oldestReset = Infinity;
  for (const [, bucket] of buckets) {
    oldestReset = Math.min(oldestReset, bucket.resetAt);
  }
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt === oldestReset) {
      buckets.delete(key);
      break;
    }
  }
}

function cleanup(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Hard cap so a single isolate cannot grow without bound. Evict oldest
  // resetAt first (LRU-ish) instead of clearing everything, so an attacker
  // flooding new keys cannot wipe out everyone else's buckets.
  let overflow = buckets.size - 5000;
  while (overflow > 0) {
    evictOldestBucket();
    overflow -= 1;
  }
}

/**
 * Minimal in-memory token-bucket guard for abuse-prone mutating endpoints.
 * Per-isolate only (Workers have no shared memory); the cron sweeper and DO
 * single-flight remain the cross-isolate backstop. Never throws at request
 * time — failures fail open so limiting can never 500 a legitimate request.
 * IP grouping is fail-closed: without a trusted CF-Connecting-IP all callers
 * share the `unknown` bucket instead of getting per-spoofed-header isolation.
 *
 * Breaking: misconfigured `opts` (non-positive windowMs/max, empty keyPrefix)
 * now throw at registration time instead of silently installing an unlimited
 * or immediately-tripping bucket. All shipped `RATE_LIMIT_DEFS` are valid.
 */
function rateLimit(opts: {
  windowMs: number;
  max: number;
  keyPrefix: string;
}): (c: RateLimitContext, next: Next) => Promise<Response | void> {
  if (!Number.isSafeInteger(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error(`Invalid rateLimit windowMs: ${String(opts.windowMs)} (must be a positive integer)`);
  }
  if (!Number.isSafeInteger(opts.max) || opts.max <= 0) {
    throw new Error(`Invalid rateLimit max: ${String(opts.max)} (must be a positive integer)`);
  }
  if (!opts.keyPrefix || opts.keyPrefix.trim().length === 0) {
    throw new Error('Invalid rateLimit keyPrefix: must be a non-empty string');
  }
  return async (c: RateLimitContext, next: Next): Promise<Response | void> => {
    // Only the *bookkeeping* is guarded. `await next()` sits outside the try
    // on purpose: a downstream throw must not reach the catch, or a
    // rate-limited request would call `next()` a second time and Hono's
    // compose throws "next() called multiple times".
    const limited = (() => {
      try {
        const now = Date.now();
        cleanup(now);
        const identity = readIdentity(c);
        const key = `${opts.keyPrefix}:${identity}`;
        const existing = buckets.get(key);
        if (!existing || existing.resetAt <= now) {
          buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
          return null;
        }
        if (existing.count >= opts.max) {
          return c.json({ Exception: { Type: 'RateLimited', Message: 'Rate limit exceeded; try again later.' } }, 429, {
            'Retry-After': String(Math.max(1, Math.ceil((existing.resetAt - now) / 1000))),
          });
        }
        existing.count += 1;
        return null;
      } catch {
        // Limiting must never 500 a legitimate request: fail open.
        return null;
      }
    })();
    if (limited) return limited;
    await next();
  };
}

function readIdentity(c: RateLimitContext): string {
  try {
    return c.get('AuthenticatedUserEmailAddress') ?? `ip:${clientIp(c)}`;
  } catch {
    return `ip:${clientIp(c)}`;
  }
}

function resetRateLimitForTests(): void {
  buckets.clear();
}

export { rateLimit, resetRateLimitForTests, clientIp, getRateLimitBucketCountForTests };
