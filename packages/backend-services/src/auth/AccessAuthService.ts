import { jwtVerify, createRemoteJWKSet } from 'jose';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { UnauthorizedError } from '@durable-dav/backend-errors';
import { DEMO_USER_EMAIL } from '@durable-dav/shared/constants';
import { isValidEmailFormat } from '@durable-dav/shared/utils';

interface AccessAuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  DEMO_USER_EMAIL?: string;
  ENVIRONMENT?: string;
}

interface AccessIdentityContext {
  access?: {
    getIdentity: () => Promise<{ email?: string | null; emailVerified?: boolean | null; email_verified?: boolean | null } | null>;
  };
}

type AccessAuthStrategy = (env: AccessAuthEnv, request: Request, accessCtx?: AccessIdentityContext) => Promise<string | null>;

function isValidAuthEmail(raw: string): boolean {
  return raw !== '' && !/\s/.test(raw) && isValidEmailFormat(raw);
}

function demoModeStrategy(env: AccessAuthEnv): Promise<string | null> {
  const config = AppConfiguration.fromEnv(env);
  if (!config.isBypassAllowed() || !config.isDemoMode()) return Promise.resolve(null);
  // `DEMO_USER_EMAIL` wins over the constant. It used to be ignored entirely,
  // so an operator who set it for a staging deploy silently authenticated every
  // request as `demo@example.com` and had no way to tell from the config that
  // the variable was inert. A malformed override falls back to the constant
  // rather than being trusted, matching `devEmailStrategy`.
  const configured = config.getDemoUserEmail()?.trim() ?? '';
  if (configured) return Promise.resolve(isValidAuthEmail(configured) ? configured.toLowerCase() : DEMO_USER_EMAIL);
  return Promise.resolve(DEMO_USER_EMAIL);
}

function devEmailStrategy(env: AccessAuthEnv): Promise<string | null> {
  const config = AppConfiguration.fromEnv(env);
  if (!config.isBypassAllowed()) return Promise.resolve(null);
  const raw = config.getDevAuthEmail()?.trim() ?? '';
  if (!raw) return Promise.resolve(null);
  // Fail closed on malformed bypass emails — fall through to JWT instead of
  // authenticating an invalid identity.
  return isValidAuthEmail(raw) ? Promise.resolve(raw.toLowerCase()) : Promise.resolve(null);
}

async function accessJwtStrategy(env: AccessAuthEnv, request: Request): Promise<string | null> {
  // Read through config, not off `env` directly: the empty-string-means-unset
  // rule and the trimming live in `AuthConfig`, and a caller that read the raw
  // var would have to re-implement both.
  const config = AppConfiguration.fromEnv(env);
  const teamDomain = config.getTeamDomain();
  const policyAud = config.getPolicyAud();
  if (teamDomain && policyAud) {
    // Fail soft so the `ctx.access` fallback stays reachable when the JWT is
    // missing/invalid. `getAuthenticatedUserEmail` throws once no strategy
    // matches — a single throw site instead of one per strategy.
    try {
      return await AccessAuthService.verifyAccessJwt(request, teamDomain, policyAud);
    } catch {
      return null;
    }
  }
  return null;
}

async function accessCtxStrategy(_env: AccessAuthEnv, _request: Request, accessCtx?: AccessIdentityContext): Promise<string | null> {
  const identity = await accessCtx?.access?.getIdentity?.().catch(() => null);
  // Fail closed on unverified identities — mirrors the JWT path's
  // `email_verified === false` reject. Access bindings are trusted, but an
  // unverified identity must never authenticate.
  if (identity?.emailVerified === false || identity?.email_verified === false) return null;
  const raw = identity?.email?.trim().toLowerCase() ?? '';
  return isValidAuthEmail(raw) ? raw : null;
}

const DEFAULT_ACCESS_AUTH_STRATEGIES: readonly AccessAuthStrategy[] = [
  demoModeStrategy,
  devEmailStrategy,
  accessJwtStrategy,
  accessCtxStrategy,
];

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

class AccessAuthService {
  private static readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  private static jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
    const normalized = trimTrailingSlashes(teamDomain.trim().toLowerCase());
    const cached = this.jwksCache.get(normalized);
    if (cached) {
      this.jwksCache.delete(normalized);
      this.jwksCache.set(normalized, cached);
      return cached;
    }
    const created = createRemoteJWKSet(new URL(`${normalized}/cdn-cgi/access/certs`));
    // Bound the cache so distinct team domains cannot grow it without limit.
    // Evict the oldest entry (LRU-ish) instead of clearing everything so an
    // attacker cycling domains cannot flush legitimate entries (DoS).
    if (this.jwksCache.size >= 10) {
      const oldest = this.jwksCache.keys().next().value;
      if (oldest !== undefined) this.jwksCache.delete(oldest);
    }
    this.jwksCache.set(normalized, created);
    return created;
  }
  private readonly strategies: readonly AccessAuthStrategy[];

  constructor(
    private readonly env: AccessAuthEnv,
    strategies: readonly AccessAuthStrategy[] = DEFAULT_ACCESS_AUTH_STRATEGIES,
  ) {
    this.strategies = strategies;
  }

  public async getAuthenticatedUserEmail(request: Request, accessCtx?: AccessIdentityContext): Promise<string> {
    for (const strategy of this.strategies) {
      const email = await strategy(this.env, request, accessCtx);
      if (email) {
        return email;
      }
    }
    // Single throw site: the JWT strategy already attempted verification and
    // failed soft, so re-verifying here would only double the JWK fetch.
    throw new UnauthorizedError('Cloudflare Access authentication failed.');
  }

  public static async verifyAccessJwt(request: Request, teamDomain?: string, policyAud?: string): Promise<string> {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) {
      throw new UnauthorizedError('No Cloudflare Access JWT token provided in request headers.');
    }

    if (!teamDomain || !policyAud) {
      throw new UnauthorizedError('Missing required JWT verification configuration.');
    }

    // Single trailing-slash normalizer (Strategy/Policy reuse): domain casing
    // is normalized, audience stays case-sensitive per JWT spec.
    const normalizedTeamDomain = trimTrailingSlashes(teamDomain.trim()).toLowerCase();
    const normalizedPolicyAud: string = policyAud.trim();
    if (!normalizedPolicyAud) {
      throw new UnauthorizedError('Missing required JWT verification configuration.');
    }
    if (normalizedPolicyAud.includes(',')) {
      throw new UnauthorizedError('Multiple JWT audiences are not supported. Configure a single POLICY_AUD value.');
    }

    try {
      const JWKS = this.jwksFor(normalizedTeamDomain);
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: normalizedTeamDomain,
        audience: normalizedPolicyAud,
      });

      if (payload.email_verified === false) {
        throw new UnauthorizedError('Cloudflare Access authentication failed.');
      }
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (!isValidAuthEmail(email)) {
        throw new UnauthorizedError('Cloudflare Access authentication failed.');
      }
      return email;
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      throw new UnauthorizedError('Cloudflare Access authentication failed.');
    }
  }
}

export { AccessAuthService, DEFAULT_ACCESS_AUTH_STRATEGIES };
export type { AccessAuthEnv, AccessIdentityContext, AccessAuthStrategy };
