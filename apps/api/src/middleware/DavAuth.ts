import type { Context } from 'hono';
import { Tokens } from '@durable-dav/backend-services/composition';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import { davErrorResponse } from '@durable-dav/webdav';
import { verifyCredential } from './credentialVerifier';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';
import { readDavHrefPrefixMode } from '@durable-dav/shared/constants';
import { ErrorSanitizationUtil } from '@durable-dav/shared/utils';
import { DatabaseError } from '@durable-dav/backend-errors';
import { BaseRoute } from '../endpoints/IBaseRoute';

type RequestContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string; AuthenticatedUserId?: string } }>;

function getScope(c: RequestContext): ReturnType<typeof BaseRoute.getScope> {
  return BaseRoute.getScope(c);
}

/**
 * Outcome of a successful WebDAV authorization.
 *
 * Only the fields the forward path actually reads are modelled. `role`,
 * `volumeId`, `isPrivate`, `credentialId` and `credentialName` were populated
 * here and consumed nowhere — the entire authorization model reduces to "is
 * this a valid credential bound to this volume id" plus the `is_private` bit
 * that produced the decision.
 */
export interface DavAuthResult {
  /**
  The owner's *current* sign-in address, or `null` for an anonymous read of a
  public bucket.

  Resolved from the volume's `owner_user_id` when migration 0004 has run, rather
  than read straight off `owner_email`. `owner_email` is the frozen anchor — it
  never changes, and for an account created against a reused address it is an
  opaque `anchor-…@users.invalid` — so forwarding it would hand the DO an address
  the owner does not sign in with. Falls back to the anchor only when the row
  predates the backfill.
  */
  userEmail: string | null;
  /**
  The owner's stable account id, or `null` on a pre-0004 row. What the DO-facing
  attribution and any future per-account accounting should key on.
  */
  userId: string | null;
  /**
  Canonical (DB-resolved) owner handle, for the `X-Dav-Base` prefix.
  */
  owner: string;
  /**
  Canonical volume name.
  */
  volume: string;
  /**
  How this bucket's `DAV:href` values are anchored.

  Read from the volume row the authorization already loaded, so honouring the
  per-bucket setting costs no extra D1 query on the DAV hot path. The front
  door turns it into the `X-Dav-Href-Prefix-Mode` header; the DO never reads D1.
  */
  hrefPrefixMode: DavHrefPrefixMode;
}

/**
 * Parse a `Basic` Authorization header.
 *
 * The scheme token is matched case-insensitively, per RFC 9110 §11.1: "auth-scheme
 * is case-insensitive". This was `header.startsWith('Basic ')`, so a client
 * sending `basic <base64>` — legal, and what some HTTP libraries emit — had its
 * credential silently ignored and fell through to the anonymous branch: a 401 on
 * a private bucket, or worse, an *anonymous* read on a public one with no
 * `X-Dav-User` attribution. Only the scheme is case-folded; the decoded
 * username/password are untouched, because they are opaque byte sequences.
 *
 * Note the password is not trimmed: the credential is `ddav_` + base64url, and
 * trimming would silently accept a mistyped credential with surrounding
 * whitespace.
 */
function getBasicCredentials(header: string | null): { username: string; password: string } | null {
  if (!header) return null;
  const separator = header.indexOf(' ');
  if ((separator === -1) || (header.slice(0, separator).toLowerCase() !== 'basic')) return null;
  try {
    const decoded = atob(header.slice(separator + 1).trim());
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    const username = decoded.slice(0, idx).trim();
    const password = decoded.slice(idx + 1);
    return !username || !password ? null : { username, password };
  } catch {
    return null;
  }
}

function unauthorizedDav(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Durable-DAV"' },
  });
}

/**
 * A write attempted with a read-only credential (migration 0005).
 *
 * 403, not 401: the credential authenticated fine — the operation is what is
 * refused, and a client that is told to authenticate again will re-prompt for
 * a password it already has, then fail again, forever. The `DAV:error` body
 * gives it the RFC 4918 §16 shape and a code to branch on.
 *
 * Deliberately carries no `WWW-Authenticate`: that header is the trigger for
 * the re-prompt loop, and repeating it on a 403 is what turns a one-line
 * refusal into a client-side stall.
 *
 * `<D:cannot-modify-protected-property/>` is the closest registered
 * precondition for "this resource refuses modification"; a server is free to
 * define its own condition element in its own namespace, but a registered code
 * is the one every existing client already knows how to read.
 */
function readOnlyCredentialDav(): Response {
  return davErrorResponse(403, 'cannot-modify-protected-property');
}

/**
 * The row's href mode, coerced in one place.
 *
 * `href_prefix_mode` is TEXT and added by migration 0003, so a row written
 * before it has no such field at all. `readDavHrefPrefixMode` maps both that and
 * any value the `CHECK` should have prevented to `base`, so an odd row keeps
 * serving the RFC-conforming shape instead of failing every DAV request.
 */
function hrefModeOf(volume: { href_prefix_mode: string }): DavHrefPrefixMode {
  return readDavHrefPrefixMode(volume.href_prefix_mode);
}

/**
 * The owner's live address and account key, for the `X-Dav-User` header.
 *
 * `owner_email` is the frozen anchor, so it is only the answer on a row that
 * predates migration 0004's backfill. When the row carries `owner_user_id` the
 * current address is read from `users` — one extra D1 read, only on a
 * credential-authenticated request, and only when it can change the answer.
 * A lookup failure is not fatal: the anchor is a safe (if stale) fallback, and
 * this runs after the request has already been authorized.
 */
async function ownerIdentity(scope: ReturnType<typeof getScope>, volume: DavVolumeRow): Promise<{ userEmail: string; userId: string | null }> {
  const ownerUserId = volume.owner_user_id;
  if (!ownerUserId) return { userEmail: volume.owner_email, userId: null };
  try {
    const account = await scope.get(Tokens.UserIdentityService).resolveUserById(ownerUserId);
    return { userEmail: account?.email ?? volume.owner_email, userId: account?.id ?? ownerUserId };
  } catch {
    return { userEmail: volume.owner_email, userId: ownerUserId };
  }
}

async function davAuthForVolume(
  c: RequestContext,
  owner: string,
  volumeName: string,
  needWrite: boolean,
): Promise<DavAuthResult | Response> {
  try {
    return await davAuthForVolumeInner(c, owner, volumeName, needWrite);
  } catch (error: unknown) {
    if (error instanceof DatabaseError) return new Response('Authentication unavailable', { status: 503 });
    throw error;
  }
}

async function davAuthForVolumeInner(
  c: RequestContext,
  owner: string,
  volumeName: string,
  needWrite: boolean,
): Promise<DavAuthResult | Response> {
  const scope = getScope(c);
  const volume = await scope.get(Tokens.VolumeService).getVolume(owner, volumeName);
  if (!volume) return new Response('Not Found', { status: 404 });

  const isPrivate = Number(volume.is_private) === 1;
  const authHeader = c.req.header('Authorization') ?? null;
  const basic = getBasicCredentials(authHeader);

  if (basic) {
    // Bucket-level credential: username AND password both validated, bound
    // to this volume id (CalDAV-style). No Bearer, no user-level PAT.
    const credentialDAO = await scope.get(Tokens.DavCredentialDAO)();
    // No `.catch` on the lookup: swallowing it here turned a D1 outage into a
    // 401 (and a native Basic re-prompt loop) instead of the 503 the wrapper
    // above maps `DatabaseError` to.
    //
    // The password is not part of the query — it is salted, so it cannot be.
    // Load by the (globally unique) username, then verify.
    const credential = await credentialDAO.getActiveByUsername(basic.username);
    if (!credential) return unauthorizedDav();
    // A malformed stored hash is a failed auth, not a 500: the row is unusable
    // either way, and surfacing 401 lets the client mint a fresh credential
    // instead of seeing an opaque error. (The throw is handled one layer down,
    // in `verifyCredential`, so all three tiers report it the same way.)
    //
    // Verification is tiered — isolate memo, then the verifier DO, then a local
    // derivation — because a single PBKDF2 derivation overruns the Free plan's
    // 10 ms CPU budget and Cloudflare answers `exceededCpu` with a 503. See
    // `credentialVerifier.ts`. The stored hash is passed in rather than looked
    // up here: the D1 read above stays per-request, so only the derivation is
    // ever reused.
    const verified = await verifyCredential(c.env, basic.username, basic.password, credential.passwordHash);
    const { ok, needsRehash, upgradedHash } = verified;
    if (!ok) return unauthorizedDav();
    if (credential.volumeId !== volume.id) return unauthorizedDav();
    // Read-only credentials (migration 0005) get exactly the read methods.
    // `needWrite` is true for everything that changes content or locks, so this
    // covers PUT/DELETE/MKCOL/COPY/MOVE/PROPPATCH and LOCK — and therefore also
    // UNLOCK, which has nothing to act on once LOCK is refused.
    //
    // Placed before the rehash and the `last_used_at` touch below so a refused
    // attempt costs no D1 write. The legacy digest is simply upgraded on the
    // next successful read instead.
    if (needWrite && credential.readOnly) return readOnlyCredentialDav();
    // Opportunistic upgrade: a credential still on the legacy unsalted
    // SHA-256 digest is re-hashed the first time it is used, so the migration
    // completes without a password-reset prompt and without a batch job.
    //
    // `upgradedHash` comes back from whichever tier verified, so the new-format
    // hash is already computed by the derivation we just paid for. This used to
    // call `hashPassword` here, which was a *second* full derivation in the
    // same request — the worst-case CPU path in the whole auth flow, and the one
    // that made a legacy credential the most likely to blow the CPU budget.
    if (needsRehash && upgradedHash) {
      await credentialDAO.updatePasswordHash(credential.credentialId, upgradedHash).catch((error: unknown) => {
        console.error('credential rehash failed; credential stays on the legacy digest', {
          credentialId: credential.credentialId,
          error: ErrorSanitizationUtil.stackForLog(error),
        });
      });
    }
    // `last_used_at` is genuinely best-effort telemetry; a failure here must
    // not fail an otherwise-valid request.
    await credentialDAO.updateLastUsed(credential.credentialId).catch(() => undefined);
    const identity = await ownerIdentity(scope, volume);
    return { ...identity, owner: volume.owner, volume: volume.name, hrefPrefixMode: hrefModeOf(volume) };
  }

  // No credential: public buckets allow anonymous reads only; all writes
  // and all private access require a bucket credential.
  if (!needWrite && !isPrivate) {
    const role = scope.get(Tokens.DavPermissionService).getRole(null, volume);
    // An anonymous read is anonymous even on a public bucket: there is no
    // caller to attribute, so this reports no owner identity rather than
    // claiming the volume's owner made the request.
    return role ? { userEmail: null, userId: null, owner: volume.owner, volume: volume.name, hrefPrefixMode: hrefModeOf(volume) } : unauthorizedDav();
  }
  return unauthorizedDav();
}

export { davAuthForVolume, unauthorizedDav };
export type { RequestContext };
