import type { Context } from 'hono';
import { Tokens } from '@durable-dav/backend-services/composition';
import { DavCredentialUtil } from '@durable-dav/shared/utils';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';
import { readDavHrefPrefixMode } from '@durable-dav/shared/constants';
import { DatabaseError } from '@durable-dav/backend-errors';
import { BaseRoute } from '../endpoints/IBaseRoute';

type RequestContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

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
  Authenticated owner email, or `null` for an anonymous read of a public bucket.
  */
  userEmail: string | null;
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
 * Note the password is not trimmed: the credential is `ddav_` + base64url, and
 * trimming would silently accept a mistyped credential with surrounding
 * whitespace.
 */
function getBasicCredentials(header: string | null): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6).trim());
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
    // A malformed stored hash throws. Treat it as a failed auth rather than a
    // 500: the row is unusable either way, and surfacing 401 lets the client
    // mint a fresh credential instead of seeing an opaque error.
    const { ok, needsRehash } = await DavCredentialUtil.verifyPassword(basic.password, credential.passwordHash).catch(() => ({
      ok: false,
      needsRehash: false,
    }));
    if (!ok) return unauthorizedDav();
    if (credential.volumeId !== volume.id) return unauthorizedDav();
    // Opportunistic upgrade: a credential still on the legacy unsalted
    // SHA-256 digest is re-hashed the first time it is used, so the migration
    // completes without a password-reset prompt and without a batch job.
    if (needsRehash) {
      await credentialDAO
        .updatePasswordHash(credential.credentialId, await DavCredentialUtil.hashPassword(basic.password))
        .catch((error: unknown) => {
          console.error('credential rehash failed; credential stays on the legacy digest', {
            credentialId: credential.credentialId,
            error: error instanceof Error ? (error.stack ?? error.message) : error,
          });
        });
    }
    // `last_used_at` is genuinely best-effort telemetry; a failure here must
    // not fail an otherwise-valid request.
    await credentialDAO.updateLastUsed(credential.credentialId).catch(() => undefined);
    return { userEmail: volume.owner_email, owner: volume.owner, volume: volume.name, hrefPrefixMode: hrefModeOf(volume) };
  }

  // No credential: public buckets allow anonymous reads only; all writes
  // and all private access require a bucket credential.
  if (!needWrite && !isPrivate) {
    const role = await scope.get(Tokens.DavPermissionService).getRole(null, volume);
    return role ? { userEmail: null, owner: volume.owner, volume: volume.name, hrefPrefixMode: hrefModeOf(volume) } : unauthorizedDav();
  }
  return unauthorizedDav();
}

export { davAuthForVolume, unauthorizedDav };
export type { RequestContext };
