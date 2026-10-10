import { describe, expect, it } from 'vitest';
import { AppConfiguration } from '../packages/backend-runtime/src/config/AppConfiguration';
import { EnvParser } from '../packages/backend-runtime/src/config/EnvParser';
import { checkVolumeQuota, parseVolumePatch } from '../packages/backend-services/src/dav/VolumeCreatePolicy';

describe('AppConfiguration hardening', () => {
  it('trims trailing slashes from SITE_URL and reports malformed numerics', () => {
    expect(new AppConfiguration({ SITE_URL: 'https://example.com///' }).getSiteUrl()).toBe('https://example.com');
    const warnings = new AppConfiguration({ MAX_VOLUMES_PER_USER: 'banana' }).validate();
    expect(warnings).toEqual(['Invalid configuration: MAX_VOLUMES_PER_USER must be a positive integer']);
    expect(new AppConfiguration({}).validate()).toEqual([]);
  });

  it('prefers DAV_CACHE_TTL_SECONDS over legacy GIT_CACHE_TTL_SECONDS', () => {
    expect(new AppConfiguration({ GIT_CACHE_TTL_SECONDS: '60' }).getDavCacheTtlSeconds()).toBe(60);
    expect(new AppConfiguration({ DAV_CACHE_TTL_SECONDS: '120', GIT_CACHE_TTL_SECONDS: '60' }).getDavCacheTtlSeconds()).toBe(120);
  });

  it('EnvParser falls back on malformed numbers', () => {
    expect(EnvParser.positiveInt({ MAX_VOLUMES_PER_USER: 'nope' }, 'MAX_VOLUMES_PER_USER', '100')).toBe(100);
    expect(EnvParser.isValidPositiveInt({ MAX_VOLUMES_PER_USER: '0' }, 'MAX_VOLUMES_PER_USER')).toBe(false);
  });
});

describe('VolumeCreatePolicy hardening', () => {
  it('rejects overlong descriptions and non-boolean visibility', () => {
    expect(() => parseVolumePatch({ description: 'x'.repeat(501) })).toThrow(/500/);
    expect(() => parseVolumePatch({ isPrivate: 'yes' })).toThrow(/boolean/);
    expect(() => parseVolumePatch({ description: 'ok', isPrivate: true })).not.toThrow();
    expect(() => checkVolumeQuota(10, 10)).toThrow(/Maximum 10 volumes/);
  });
});

// The second error→HTTP mapper that used to live in
// `packages/backend-services/src/errors/` was removed: it had no production
// caller, and disagreed with the live one (`BaseRoute.toErrorResponse`) —
// collapsing every 5xx to 500 where the live path passes a `DatabaseError`'s
// code through. Keeping a tested-but-unused twin of a security-adjacent mapping
// is a trap; the assertions that pinned it moved to `error-mapping.test.ts`,
// against the mapper that actually runs.
describe('error→HTTP mapping has exactly one implementation', () => {
  it('exposes no second mapper from backend-services', async () => {
    const barrel = await import('../packages/backend-services/src/index');
    expect(barrel).not.toHaveProperty('mapServiceError');
    expect(barrel).not.toHaveProperty('toServiceStatus');
  });
});
