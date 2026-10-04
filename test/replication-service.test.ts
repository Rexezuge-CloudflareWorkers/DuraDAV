import { describe, expect, it } from 'vitest';
import {
  VolumeReplicationService,
  normalizeRemotePath,
  normalizeInterval,
  oneOf,
  REPLICATION_INTERVALS,
} from '@durable-dav/backend-services/dav';
import { encryptReplicationSecret, decryptReplicationSecret, generateReplicationKey, ReplicationKeyError } from '@durable-dav/backend-data/crypto';
import { BadRequestError } from '@durable-dav/backend-errors';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';

/**
 * Owner-facing validation and the credential envelope.
 *
 * Every field here arrives as `unknown` off the wire, and each wrong type has a
 * silent outcome — a `"false"` reaching `enabled`, a non-string landing in a
 * `TEXT` column, an unknown `mode` hitting a `CHECK` and becoming a 500 instead of
 * the 400 the caller deserves. These are the tests that keep those 400s.
 */

function serviceWith(overrides: Record<string, string> = {}): VolumeReplicationService {
  return new VolumeReplicationService({ DB: {} as never, REPLICATION_ENCRYPTION_KEY: generateReplicationKey(), ...overrides });
}

describe('oneOf', () => {
  it('narrows a member of the closed set', () => {
    expect(oneOf('sync', ['copy-only', 'sync'] as const, 'mode')).toBe('sync');
  });

  it('returns the fallback only for an absent value', () => {
    expect(oneOf(undefined, ['a', 'b'] as const, 'mode', 'b')).toBe('b');
    expect(oneOf(null, ['a', 'b'] as const, 'mode', 'b')).toBe('b');
  });

  it('rejects a member of the wrong type without coercing it', () => {
    // `"true"` is the case that matters: quietly reading it as `enabled = true`
    // would be a silent difference in who may read the target.
    expect(() => oneOf('yes', ['a', 'b'] as const, 'mode')).toThrow(BadRequestError);
    expect(() => oneOf(1, ['a', 'b'] as const, 'mode')).toThrow(BadRequestError);
    expect(() => oneOf(undefined, ['a', 'b'] as const, 'mode')).toThrow(/mode is required/);
  });

  it('names the field and the allowed set in the message', () => {
    expect(() => oneOf('nope', ['a', 'b'] as const, 'mode')).toThrow(/mode must be one of: a, b/);
  });
});

describe('normalizeInterval', () => {
  it('defaults to an hour', () => {
    expect(normalizeInterval(undefined)).toBe(60);
  });

  it('accepts every offered interval', () => {
    for (const minutes of REPLICATION_INTERVALS) expect(normalizeInterval(minutes)).toBe(minutes);
  });

  it('rejects an interval that is not offered', () => {
    // The sweep budget is shared across the deployment, so a one-minute interval
    // does not sync more often — it starves every other bucket.
    expect(() => normalizeInterval(1)).toThrow(BadRequestError);
    expect(() => normalizeInterval(0)).toThrow(BadRequestError);
    expect(() => normalizeInterval(-60)).toThrow(BadRequestError);
  });

  it('rejects a numeric string rather than parsing it', () => {
    // The type is checked before the value, so a JSON body that quotes its
    // numbers is a 400 instead of a silent success on the values that happen to
    // parse.
    expect(() => normalizeInterval('60')).toThrow(BadRequestError);
  });
});

describe('normalizeRemotePath', () => {
  it('normalizes separators and drops empty segments', () => {
    expect(normalizeRemotePath('backups/bucket')).toBe('backups/bucket');
    expect(normalizeRemotePath('backups//bucket')).toBe('backups/bucket');
    expect(normalizeRemotePath('backups/./bucket')).toBe('backups/bucket');
    expect(normalizeRemotePath('')).toBe('');
    expect(normalizeRemotePath(undefined)).toBe('');
  });

  it('rejects a leading slash and any ".." segment', () => {
    // A path that has to be rewritten to become safe is one someone constructed
    // to leave the configured root — and in `keep-both` mode, to delete there too.
    expect(() => normalizeRemotePath('/etc')).toThrow(/must not start with/);
    expect(() => normalizeRemotePath('a/../../etc')).toThrow(/\.\./);
    expect(() => normalizeRemotePath('../escape')).toThrow(/\.\./);
  });

  it('rejects a non-string', () => {
    expect(() => normalizeRemotePath(5)).toThrow(/must be a string/);
  });
});

describe('VolumeReplicationService.allowedIntervals', () => {
  it('is the closed list the UI mirrors', () => {
    expect(VolumeReplicationService.allowedIntervals()).toEqual([...REPLICATION_INTERVALS]);
  });
});

describe('replication credential envelope', () => {
  it('round-trips a secret', async () => {
    const key = generateReplicationKey();
    const envelope = await encryptReplicationSecret('user:hunter2', key);
    expect(envelope.ciphertext).not.toContain('hunter2');
    expect(envelope.iv).not.toBe(envelope.ciphertext);
    await expect(decryptReplicationSecret(envelope, key)).resolves.toBe('user:hunter2');
  });

  it('uses a fresh IV per call', async () => {
    // Reusing an IV under one key destroys GCM's guarantees outright, which is
    // why the IV is returned rather than kept internal.
    const key = generateReplicationKey();
    const first = await encryptReplicationSecret('same', key);
    const second = await encryptReplicationSecret('same', key);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('fails closed when the key is missing, rather than storing plaintext', async () => {
    // The alternative — passing the value through when it cannot encrypt — would
    // store the remote password in the clear on exactly the deployments that
    // forgot to configure a key, and nothing would report it.
    await expect(encryptReplicationSecret('user:hunter2', undefined)).rejects.toThrow(ReplicationKeyError);
    await expect(encryptReplicationSecret('user:hunter2', '')).rejects.toThrow(ReplicationKeyError);
    await expect(encryptReplicationSecret('user:hunter2', 'not-base64!!')).rejects.toThrow(ReplicationKeyError);
  });

  it('rejects a key of the wrong length', async () => {
    await expect(encryptReplicationSecret('x', btoa('short'))).rejects.toThrow(/32 bytes/);
  });

  it('reports a wrong key rather than returning garbage', async () => {
    // A replication row that cannot be decrypted must report `failed`; returning
    // something would let the remote answer 401 and the owner would debug the
    // wrong thing.
    const envelope = await encryptReplicationSecret('user:hunter2', generateReplicationKey());
    await expect(decryptReplicationSecret(envelope, generateReplicationKey())).rejects.toThrow(ReplicationKeyError);
  });

  it('reports a tampered ciphertext', async () => {
    const key = generateReplicationKey();
    const envelope = await encryptReplicationSecret('user:hunter2', key);
    const flipped = `${envelope.ciphertext.slice(0, -2)}${envelope.ciphertext.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(decryptReplicationSecret({ ...envelope, ciphertext: flipped }, key)).rejects.toThrow(ReplicationKeyError);
  });
});

describe('AppConfiguration — replication settings', () => {
  it('defaults every replication limit', () => {
    const config = AppConfiguration.fromEnv({});
    expect(config.getReplicationSweepLimit()).toBe(10);
    expect(config.getReplicationSlicePaths()).toBe(200);
    expect(config.getReplicationSliceBytes()).toBe(33_554_432);
    expect(config.getReplicationSliceMs()).toBe(20_000);
    expect(config.getReplicationPassMaxMs()).toBe(600_000);
    expect(config.getMaxReplicationFailures()).toBe(5);
    expect(config.getMaxReplicationsPerVolume()).toBe(10);
    expect(config.getReplicationTimeoutMs()).toBe(30_000);
    expect(config.getReplicationAllowedHosts()).toBe('');
    expect(config.isReplicationHashOnAmbiguous()).toBe(false);
  });

  it('falls back to the default for a malformed limit rather than failing at request time', () => {
    const config = AppConfiguration.fromEnv({ REPLICATION_SLICE_PATHS: 'banana' });
    expect(config.getReplicationSlicePaths()).toBe(200);
  });

  it('reports a malformed limit through validate()', () => {
    const warnings = AppConfiguration.fromEnv({ REPLICATION_SLICE_PATHS: 'banana' }).validate();
    expect(warnings.some((w) => w.includes('REPLICATION_SLICE_PATHS'))).toBe(true);
  });

  it('does not warn about the allowlist by default', () => {
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production' }).validate();
    expect(warnings.some((w) => w.includes('REPLICATION_ALLOWED_HOSTS'))).toBe(false);
  });

  it('warns when the SSRF allowlist is widened in production', () => {
    // It is the one setting that widens an egress boundary, so a production
    // deployment that has set it is told so at startup rather than from an audit.
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', REPLICATION_ALLOWED_HOSTS: 'nextcloud.lan' }).validate();
    expect(warnings.some((w) => w.includes('REPLICATION_ALLOWED_HOSTS') && w.includes('Security'))).toBe(true);
  });

  it('does not warn about the allowlist outside production', () => {
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'staging', REPLICATION_ALLOWED_HOSTS: 'nextcloud.lan' }).validate();
    expect(warnings.some((w) => w.includes('REPLICATION_ALLOWED_HOSTS'))).toBe(false);
  });
});

describe('VolumeReplicationService — construction', () => {
  it('constructs without touching D1, so a request that resolves nothing pays nothing', () => {
    expect(() => serviceWith()).not.toThrow();
  });
});
