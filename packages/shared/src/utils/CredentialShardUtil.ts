/**
 * Shard assignment for password-verification offload.
 *
 * ## Why this lives in `shared` and not next to the verifier
 *
 * The caller (`apps/api`) must pick the same shard the verifier DO would, and
 * `apps/api` already depends on `apps/background` for DO *bindings* only — a
 * runtime import of the background barrel would pull every DO class (and
 * `cloudflare:workers`) into the front-door bundle and into the unit-test module
 * graph. `doStubs.ts` gets away with it by importing `DavVolumeWorker`
 * type-only. This is a pure function, so it belongs in Layer 0 where both sides
 * can reach it without that coupling, and where the two sides cannot disagree
 * about the answer.
 */

/**
 * Number of verifier shards.
 *
 * A Durable Object serializes its handlers, so a single un-sharded verifier
 * would make every concurrent authentication queue behind one object — a
 * throughput ceiling on the entire WebDAV auth path. 32 keeps the per-object
 * load low while staying well inside the free plan's class/namespace limits.
 */
const CREDENTIAL_SHARD_COUNT = 32;

/**
 * Stable shard index for a username.
 *
 * FNV-1a, 32-bit. Deliberately *not* cryptographic and it does not need to be:
 * the only goal is spreading usernames across shards, and the result is a
 * routing decision rather than a secret. `crypto.subtle.digest` would also work
 * but is async, and this runs in the caller's critical path before the RPC.
 *
 * Stability matters more than quality — the caller and the verifier must reach
 * the same shard without exchanging state.
 */
function credentialShardOf(username: string): number {
  let hash = 0x81_1c_9d_c5;
  // Iterated by code unit rather than by code point: FNV-1a is defined over
  // bytes, and a code-unit walk is stable for any JS string without decoding,
  // which is all a routing decision needs. A username with an astral character
  // hashes its two surrogate halves, which is still deterministic.
  for (let i = 0; i < username.length; i += 1) {
    hash ^= username.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0) % CREDENTIAL_SHARD_COUNT;
}

export { credentialShardOf, CREDENTIAL_SHARD_COUNT };