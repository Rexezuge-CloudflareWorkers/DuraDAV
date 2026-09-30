import { describe, expect, it } from 'vitest';
import { AppConfiguration } from '../packages/backend-runtime/src/config/AppConfiguration';
import { EnvParser } from '../packages/backend-runtime/src/config/EnvParser';
import { checkVolumeQuota, parseVolumePatch } from '../packages/backend-services/src/dav/VolumeCreatePolicy';
import { deserializeErrorBody, parseErrorPayload } from '../packages/backend-services/src/errors/ErrorDeserializationUtil';
import { mapServiceError, toServiceStatus } from '../packages/backend-services/src/errors/ErrorMapper';
import { BadRequestError, DatabaseError } from '../packages/backend-errors';

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

describe('Error handling hardening', () => {
  it('deserializes typed errors and degrades unknown types to 500', () => {
    expect(deserializeErrorBody({ Exception: { Type: 'NotFound', Message: 'missing' } }, 'fb').getErrorType()).toBe('NotFound');
    expect(deserializeErrorBody({ Exception: { Type: 'Nope', Message: 'x' } }, 'fb').getErrorType()).toBe('InternalServerError');
    expect(parseErrorPayload('plain boom', 502).message).toBe('plain boom');
    expect(parseErrorPayload({ error: 'BadRequest', message: 'bad' }, 400).getErrorType()).toBe('BadRequest');
  });

  it('maps service errors to HTTP status without leaking internals', () => {
    expect(toServiceStatus(new BadRequestError('bad'))).toBe(400);
    const mapped = mapServiceError(new DatabaseError('db down'));
    expect(mapped.status).toBe(500);
    expect(mapped.body.Exception?.Type).toBe('DatabaseError');
  });
});
