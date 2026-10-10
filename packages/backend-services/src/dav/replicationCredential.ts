import { BadRequestError } from '@durable-dav/backend-errors';
import { MAX_NAME_LENGTH, optionalSecret, optionalString, sealableSecret } from './replicationInput';
import type { ReplicationAuthKind } from './replicationInput';

/**
 * How a replication target's credential is turned into a stored envelope.
 *
 * Split out of `VolumeReplicationService` because this is the whole of the rule that
 * broke, and it has to be readable in one place: `createReplication` sealed a bare
 * password while `buildRemote`'s `authHeader` splits the blob on a colon and expects
 * a `user:` prefix, so **every** `basic` replication failed its first pass with
 * "stored replication credential is malformed" — and `rotateSecret` ran the same
 * broken composition, so the error's own advice to rotate it changed nothing.
 *
 * Two things follow, and both are enforced here rather than at the call sites:
 *
 * 1. **One composition, two callers.** Create and rotate both go through here. They
 *    diverged once, and the divergence was invisible because each was individually
 *    plausible.
 * 2. **The writer is asserted against the reader.** `sealableSecret` produces exactly
 *    what `authHeader` consumes — `user:password`, split on the *first* colon per
 *    RFC 7617 — and `test/replication-credential.test.ts` drives the real service and
 *    decrypts what it stored. A suite that hands the reader a hand-built envelope
 *    cannot catch a writer emitting the wrong shape; that is how this shipped.
 *
 * ## Why `username` is not stored in a column
 *
 * `dav_replications` has no `remote_username`, so the username travels inside the
 * encrypted value as its prefix. That keeps one secret in one column and never
 * publishes the handle to a projection, at the cost of making rotation re-ask for it:
 * preserving it would mean decrypting the old credential purely to re-seal it, which
 * fails in exactly the situation an owner reaches for a rotation.
 *
 * Rows written before this existed cannot be repaired — the username was never stored
 * anywhere — so they are listed read-only by `scripts/replication-credential-audit.ts`.
 */

export type CredentialEnvelope = { ciphertext: string; iv: string } | { ciphertext: null; iv: null };

/**
 * Validate a credential and return the plaintext to seal, or `''` for "no credential".
 *
 * Pure, and separate from sealing, so `createReplication` can validate *before* its
 * quota and duplicate-target checks while still sealing only once it is about to
 * write. Validating at the point of the write would reorder the 400s — a request that
 * is both over quota and missing its username would report the quota instead.
 */
function credentialPlaintext(authKind: ReplicationAuthKind, username: unknown, secret: unknown): string {
  const name = optionalString(username, 'username', MAX_NAME_LENGTH);
  // `optionalSecret`, not `optionalString`: a password is opaque octets and RFC 7617
  // puts everything after the first colon into it verbatim, so trimming silently
  // changes the credential the owner chose and turns a correct one into a 401.
  const value = authKind === 'none' ? '' : optionalSecret(secret, 'secret');
  if (authKind !== 'none' && value === '') throw new BadRequestError(`secret is required when authKind is ${authKind}`);
  if (authKind === 'basic' && name === '') throw new BadRequestError('username is required when authKind is basic');
  return sealableSecret(authKind, name, value);
}

/**
 * Validate and seal one credential, for the path that writes immediately.
 *
 * `seal` is injected rather than imported so this module stays free of the encryption
 * key and its resolution rules; the service owns that, and passes the same
 * `replicationKey` provider it uses for every other secret.
 *
 * `null` for an empty result rather than an envelope that decrypts to `''`:
 * `encrypted_secret` is documented as null whenever `auth_kind = 'none'`, and a blob
 * that opens to nothing is indistinguishable from a real credential to anything
 * reading the row.
 */
async function buildCredentialEnvelope(
  authKind: ReplicationAuthKind,
  username: unknown,
  secret: unknown,
  seal: (plaintext: string) => Promise<{ ciphertext: string; iv: string }>,
): Promise<CredentialEnvelope> {
  const plaintext = credentialPlaintext(authKind, username, secret);
  return plaintext === '' ? { ciphertext: null, iv: null } : seal(plaintext);
}

export { buildCredentialEnvelope, credentialPlaintext };