/**
 * The replication key's Secrets Store binding.
 *
 * `REPLICATION_ENCRYPTION_KEY` used to be a plain `wrangler secret`, which is a
 * base64 string sitting in the environment of every isolate. It is now read from
 * a `secrets_store_secrets` binding. The plain var remains a non-production
 * fallback so local dev and unit tests work with nothing provisioned.
 *
 * The rule these tests pin: **the binding wins, and production refuses the var.**
 * Silently accepting a plaintext env var in production would make the two look
 * interchangeable when they are a different trust boundary — the exact thing the
 * move was meant to stop.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveReplicationKey } from '../packages/backend-data/src/crypto/replicationKey';
import { ReplicationKeyError } from '../packages/backend-data/src/crypto/aes-gcm';
import { AppConfiguration } from '../packages/backend-runtime/src/config/AppConfiguration';

describe('resolveReplicationKey source preference', () => {
  it('reads from the binding when one is present', async () => {
    const get = vi.fn().mockResolvedValue('from-binding');
    const key = resolveReplicationKey({ binding: { get }, rawVar: 'from-var', isProduction: true });
    await expect(key()).resolves.toBe('from-binding');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw var outside production', async () => {
    const key = resolveReplicationKey({ rawVar: 'from-var', isProduction: false });
    await expect(key()).resolves.toBe('from-var');
  });

  it('REFUSES the raw var in production and names the binding', async () => {
    const key = resolveReplicationKey({ rawVar: 'from-var', isProduction: true });
    // The message must point at the fix, not just the symptom.
    await expect(key()).rejects.toThrow(/REPLICATION_ENCRYPTION_KEY_SECRET/);
    await expect(key()).rejects.toBeInstanceOf(ReplicationKeyError);
  });

  it('throws when nothing is configured at all', async () => {
    const key = resolveReplicationKey({ isProduction: false });
    await expect(key()).rejects.toThrow(/not configured/);
  });

  it('propagates a binding failure rather than falling back to the var', async () => {
    // A broken binding must not be papered over with the plaintext var in
    // production — that is the failure the change exists to make visible.
    const key = resolveReplicationKey({
      binding: { get: () => Promise.reject(new Error('store unreachable')) },
      rawVar: 'from-var',
      isProduction: true,
    });
    await expect(key()).rejects.toThrow('store unreachable');
  });
});

describe('resolveReplicationKey memoization', () => {
  it('fetches the binding at most once across many lookups', async () => {
    const get = vi.fn().mockResolvedValue('k');
    const key = resolveReplicationKey({ binding: { get }, isProduction: true });
    await Promise.all([key(), key(), key()]);
    await key();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('caches the rejection so a failing binding is not re-fetched per lookup', async () => {
    const get = vi.fn().mockRejectedValue(new Error('store unreachable'));
    const key = resolveReplicationKey({ binding: { get }, isProduction: true });
    await expect(key()).rejects.toThrow('store unreachable');
    await expect(key()).rejects.toThrow('store unreachable');
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('production warning for the superseded var', () => {
  it('warns when REPLICATION_ENCRYPTION_KEY is set while ENVIRONMENT=production', () => {
    const warnings = new AppConfiguration({
      ENVIRONMENT: 'production',
      REPLICATION_ENCRYPTION_KEY: 'plaintext-key',
    }).validate();
    expect(warnings.some((warning) => warning.includes('REPLICATION_ENCRYPTION_KEY'))).toBe(true);
  });

  it('does not warn when only the binding is configured', () => {
    // A binding is not a string env value, so it cannot reach the parser — the
    // correct production setup must produce no warning.
    expect(new AppConfiguration({ ENVIRONMENT: 'production' }).validate()).toEqual([]);
  });

  it('does not warn outside production, where the var is the supported path', () => {
    expect(
      new AppConfiguration({ ENVIRONMENT: 'development', REPLICATION_ENCRYPTION_KEY: 'plaintext-key' }).validate(),
    ).toEqual([]);
  });
});

describe('the egress allowlist has one parse', () => {
  it('splits, trims and drops empties', () => {
    const config = new AppConfiguration({ REPLICATION_ALLOWED_HOSTS: ' a.example.com , ,b.example.com, ' });
    expect(config.getReplicationAllowedHostList()).toEqual(['a.example.com', 'b.example.com']);
  });

  it('is empty for an unset allowlist', () => {
    expect(new AppConfiguration({}).getReplicationAllowedHostList()).toEqual([]);
  });

  it('returns a copy, so a caller cannot mutate the parsed list for the next one', () => {
    const config = new AppConfiguration({ REPLICATION_ALLOWED_HOSTS: 'a.example.com' });
    const first = config.getReplicationAllowedHostList() as string[];
    first.push('attacker.example.com');
    expect(config.getReplicationAllowedHostList()).toEqual(['a.example.com']);
  });
});