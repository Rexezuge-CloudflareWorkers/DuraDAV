// Single-KV keyspace: one `CACHE` binding, domains separated by key prefix.
//
// Rationale: D1 and the Durable Object stay the source of truth. KV is a
// loss-tolerant, read-heavy cache only — a miss or eviction must always be
// recoverable by recompute. Call sites never touch `env.CACHE` directly; they
// go through `KvCache` with a closed `KvDomainName` registry so prefixes cannot
// collide and TTL/size policy lives in one table.

const KV_KEY_VERSION = 'v1';
const KV_MAX_KEY_LENGTH = 512;
const KV_MIN_TTL_SECONDS = 60;

type KvDomainName = 'davProp' | 'davFile' | 'davMeta';

interface KvDomainDef {
  ttlSeconds: number;
  maxValueBytes: number;
  description: string;
}

const KV_DOMAINS: Record<KvDomainName, KvDomainDef> = {
  davProp: {
    ttlSeconds: 120,
    maxValueBytes: 1_048_576,
    description: 'PROPFIND multistatus snapshots per volume+path+depth+body; invalidated on write.',
  },
  davFile: {
    ttlSeconds: 300,
    maxValueBytes: 10_485_760,
    description: 'File GET bodies (binary + etag/contentType metadata) per volume+path; invalidated on write. Only under size cap.',
  },
  davMeta: {
    ttlSeconds: 60,
    maxValueBytes: 65_536,
    description: 'Volume list snapshots per owner email; invalidated on volume mutation. Keyed on the owner, not the volume.',
  },
};

/**
 * 128-bit digest built from four independent FNV-1a lanes.
 *
 * Why not a single 32-bit FNV: `buildKvKey` falls back to a digest when a key
 * exceeds the platform's 512-character limit, and `davFile` keys embed a
 * user-controlled file path. A 32-bit digest over a shared keyspace is
 * collision-searchable — an attacker who controls paths in their own volume
 * could grind a colliding key and read another tenant's cached bytes. Four
 * lanes over the same bytes with different offsets/primes cost one extra pass
 * and take a birthday collision to ~2^64 work, which is not worth attacking.
 *
 * Synchronous on purpose: `buildKvKey` is called from sync cache-key builders.
 */
function digest128(input: string): string {
  const LANES = 4;
  const offsets = [0x81_1c_9d_c5, 0xc2_b2_ae_35, 0x27_d4_eb_2f, 0x16_56_67_b1];
  let out = '';
  for (let lane = 0; lane < LANES; lane += 1) {
    let hash = offsets[lane];
    const prime = 0x01_00_01_93 + lane * 0x9e_37_79_b9;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.codePointAt(i) ?? 0;
      hash = Math.imul(hash, prime);
    }
    out += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

function sanitizeSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) throw new Error('KV key segment must not be empty.');
  return encodeURIComponent(trimmed);
}

function buildKvKey(domain: KvDomainName, parts: readonly string[]): string {
  const def = KV_DOMAINS[domain];
  if (!def) throw new Error(`Unknown KV domain: ${domain}.`);
  if (parts.length === 0) throw new Error(`KV domain ${domain} requires at least one key part.`);
  const prefix = `${domain}:${KV_KEY_VERSION}:`;
  const joined = parts.map((part) => sanitizeSegment(part)).join(':');
  const full = prefix + joined;
  if (full.length <= KV_MAX_KEY_LENGTH) return full;
  // Deterministic overflow form. Note the consequence for invalidation: an
  // overflowing key does not start with `<domain>:<version>:<volume>`, so
  // `purgePrefix` on a volume will not match it. Callers must therefore bound
  // the path length they cache — see `MAX_CACHEABLE_PATH_LENGTH` in
  // `DavReadCache`.
  return `${prefix}h:${digest128(joined)}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Resolve a TTL, defaulting to the domain's own. Every domain declares a
 * required `ttlSeconds`, so there is no "no TTL" case to represent.
 */
function clampTtl(ttlSeconds: number | undefined, domain: KvDomainName): number {
  const effective = ttlSeconds ?? KV_DOMAINS[domain].ttlSeconds;
  return Number.isFinite(effective) ? Math.max(KV_MIN_TTL_SECONDS, Math.floor(effective)) : KV_DOMAINS[domain].ttlSeconds;
}

export { KV_DOMAINS, KV_MAX_KEY_LENGTH, buildKvKey, clampTtl, digest128, utf8ByteLength };
export type { KvDomainDef, KvDomainName };
