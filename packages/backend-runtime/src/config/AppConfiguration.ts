import { EnvParser } from './EnvParser';
import { DEFAULT_SITE_URL } from './ConfigurationDefaults';

import { AuthConfig } from './sections/AuthConfig';
import { DavLimits } from './sections/DavLimits';
import { ReplicationConfig } from './sections/ReplicationConfig';
import { VolumeLimits } from './sections/VolumeLimits';

/**
 * Injectable instance view over Durable-DAV environment configuration.
 *
 * A thin facade over focused section objects (`VolumeLimits`, `DavLimits`,
 * `AuthConfig`, `ReplicationConfig`), each of which owns one group of
 * `AppConfiguration` getters so env parsing lives in one place per concern.
 *
 * Accept `AppConfiguration` by constructor injection so env parsing is stubbable;
 * the section objects are deliberately **not** exposed as getters. They were, and
 * nothing used them: a caller holding a section bypasses the facade and reaches
 * `EnvParser` on its own, which is the coupling the facade exists to prevent.
 */
class AppConfiguration {
  private readonly volumes: VolumeLimits;
  private readonly dav: DavLimits;
  private readonly auth: AuthConfig;
  private readonly replication: ReplicationConfig;

  constructor(private readonly env: unknown) {
    this.volumes = new VolumeLimits(env);
    this.dav = new DavLimits(env);
    this.auth = new AuthConfig(env);
    this.replication = new ReplicationConfig(env);
  }

  public static fromEnv(env: unknown): AppConfiguration {
    return new AppConfiguration(env);
  }

  public getReplicationSweepLimit(): number {
    return this.replication.getReplicationSweepLimit();
  }

  public getReplicationSlicePaths(): number {
    return this.replication.getReplicationSlicePaths();
  }

  public getReplicationSliceBytes(): number {
    return this.replication.getReplicationSliceBytes();
  }

  public getReplicationSliceMs(): number {
    return this.replication.getReplicationSliceMs();
  }

  public getReplicationPassMaxMs(): number {
    return this.replication.getReplicationPassMaxMs();
  }

  public getMaxReplicationFailures(): number {
    return this.replication.getMaxReplicationFailures();
  }

  public getMaxReplicationsPerVolume(): number {
    return this.replication.getMaxReplicationsPerVolume();
  }

  public getReplicationTimeoutMs(): number {
    return this.replication.getReplicationTimeoutMs();
  }

  public getReplicationAllowedHosts(): string {
    return this.replication.getReplicationAllowedHosts();
  }

  public isReplicationHashOnAmbiguous(): boolean {
    return this.replication.isReplicationHashOnAmbiguous();
  }

  public getSiteUrl(): string {
    let url = EnvParser.string(this.env, 'SITE_URL', DEFAULT_SITE_URL);
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  public getMaxVolumesPerUser(): number {
    return this.volumes.getMaxVolumesPerUser();
  }

  public getMaxCredentialsPerVolume(): number {
    return this.volumes.getMaxCredentialsPerVolume();
  }

  public getDefaultCredentialExpiryDays(): number {
    return this.volumes.getDefaultCredentialExpiryDays();
  }

  public getMaxCredentialExpiryDays(): number {
    return this.volumes.getMaxCredentialExpiryDays();
  }

  public getDoDeviceBytes(): number {
    return this.volumes.getDoDeviceBytes();
  }

  public getDavCacheTtlSeconds(): number {
    return this.dav.getDavCacheTtlSeconds();
  }

  public getMaxFileBytes(): number {
    return this.dav.getMaxFileBytes();
  }

  public isDemoMode(): boolean {
    return this.auth.isDemoMode();
  }

  public getEnvironment(): string {
    return this.auth.getEnvironment();
  }

  public isBypassAllowed(): boolean {
    return this.auth.isBypassAllowed();
  }

  public getDevAuthEmail(): string | null {
    return this.auth.getDevAuthEmail();
  }

  public getDemoUserEmail(): string | null {
    return this.auth.getDemoUserEmail();
  }

  public getTeamDomain(): string | null {
    return this.auth.getTeamDomain();
  }

  public getPolicyAud(): string | null {
    return this.auth.getPolicyAud();
  }

  /**
   * Fail-fast misconfiguration report (why: `EnvParser` silent fallback hid
   * typos like `MAX_FILE_BYTES=banana`). Returns human-readable warnings
   * for explicitly-set but malformed numeric vars; empty means clean.
   *
   * Called once per isolate at worker startup — never per-request.
   */
  public validate(): string[] {
    const warnings: string[] = [];
    const numericKeys = [
      'MAX_VOLUMES_PER_USER',
      'MAX_CREDENTIALS_PER_VOLUME',
      'DEFAULT_CREDENTIAL_EXPIRY_DAYS',
      'MAX_CREDENTIAL_EXPIRY_DAYS',
      'MAX_FILE_BYTES',
      'DAV_CACHE_TTL_SECONDS',
      'DO_DEVICE_BYTES',
      'REPLICATION_SWEEP_LIMIT',
      'REPLICATION_SLICE_PATHS',
      'REPLICATION_SLICE_BYTES',
      'REPLICATION_SLICE_MS',
      'REPLICATION_PASS_MAX_MS',
      'MAX_REPLICATION_FAILURES',
      'MAX_REPLICATIONS_PER_VOLUME',
      'REPLICATION_TIMEOUT_MS',
    ];
    for (const key of numericKeys) {
      if (!EnvParser.isValidPositiveInt(this.env, key)) {
        warnings.push(`Invalid configuration: ${key} must be a positive integer`);
      }
    }
    // An auth bypass in production is a full account takeover, so it is worth a
    // loud warning even though `AuthConfig.isBypassAllowed` already refuses to
    // act on it. This catches the deployment mistake rather than the request.
    if (this.getEnvironment() === 'production' && (this.getDevAuthEmail() !== null || this.isDemoMode())) {
      warnings.push(
        'Security: DEV_AUTH_EMAIL or DEMO_MODE is set while ENVIRONMENT=production. These bypass authentication for every unauthenticated request and are ignored in production — remove them.',
      );
    }
    // The egress allowlist is the one setting that widens an SSRF boundary, so
    // a production deployment that has set it is told so at startup rather than
    // discovering it from an audit. An unset value is the safe default and
    // produces no warning.
    if (this.getEnvironment() === 'production' && this.getReplicationAllowedHosts().trim() !== '') {
      warnings.push(
        'Security: REPLICATION_ALLOWED_HOSTS is set while ENVIRONMENT=production. It exempts the listed hosts from the egress policy that blocks loopback and private-network targets — confirm every entry is intended.',
      );
    }
    return warnings;
  }
}

export { AppConfiguration };
