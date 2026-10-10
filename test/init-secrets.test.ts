/**
 * CI provisioning of the Secrets Store values `wrangler deploy` binds.
 *
 * ## The failure these tests exist to prevent
 *
 * The deploy of `REPLICATION_ENCRYPTION_KEY_SECRET` failed three times in a row
 * because the secret it binds was never created. The cause was two defects in
 * `scripts/init-secrets.ts`, and only the first was visible in the source:
 *
 * 1. The generator allowlist was still the one inherited from the project's
 *    previous name — five `edge-git-*` names, all deleted at the rename. The
 *    real secret matched none of them, so the script threw `Unknown secret` on
 *    its first iteration and created nothing.
 * 2. That throw was invisible. The script ended in `main().catch(console.error)`,
 *    and `console.error` returns `undefined` without setting an exit status, so
 *    the process exited **0** and CI reported the step as successful. The
 *    failure only surfaced one step later as an unexplained `wrangler deploy`
 *    error against a secret that had never existed.
 *
 * A provisioning script that cannot report its own failure is worse than no
 * provisioning script, so the guards below cover both halves: the names the
 * template declares must be the names the script can produce, and a failing run
 * must exit non-zero.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { decryptReplicationSecret, encryptReplicationSecret } from '../packages/backend-data/src/crypto/aes-gcm';
import {
  canProvisionSecret,
  parseSecretNames,
  planSecrets,
  provisionableSecretNames,
  provisionSecretValue,
} from '../scripts/init-secrets';

const initSecretsScript = fileURLToPath(new URL('../scripts/init-secrets.ts', import.meta.url));

const template = parse(
  readFileSync(fileURLToPath(new URL('../apps/api/wrangler.template.jsonc', import.meta.url)), 'utf8'),
) as { secrets_store_secrets?: Array<{ binding?: string; secret_name?: string }> };

const declaredSecretNames = (): string[] => (template.secrets_store_secrets ?? []).map((secret) => secret.secret_name ?? '');

/**
 * A `cli-table3` rendering, which is all `wrangler secrets-store secret list`
 * emits — there is no `--json`. Data rows are separated with `│`; the header and
 * separator rows use `┼` and `├`/`┤`, so they carry no `│` at all.
 */
const secretTable = (...names: string[]): string =>
  [
    '┌───────────────────────────┬──────────┬─────────┬─────────┬─────────┬──────────────────────┬──────────────────────┐',
    '│ Name                      │ ID       │ Comment │ Scopes  │ Status  │ Created              │ Modified             │',
    '├───────────────────────────┼──────────┼─────────┼─────────┼─────────┼──────────────────────┼──────────────────────┤',
    ...names.map((name, index) => `│ ${name.padEnd(25)} │ ${String(index).padEnd(8)} │         │ workers │ active  │ 10/9/2026, 4:12:00 PM │ 10/9/2026, 4:12:00 PM │`),
    '└───────────────────────────┴──────────┴─────────┴─────────┴─────────┴──────────────────────┴──────────────────────┘',
  ].join('\n');

describe('the deploy template and the provisioning script agree', () => {
  it('can provision every secret the template binds', () => {
    // The regression itself: the template declared
    // `durable-dav-replication-encryption-key` while the script only knew
    // `edge-git-*` names, so it threw on the first entry and the deploy could
    // never succeed.
    const unprovisionable = declaredSecretNames().filter((name) => !canProvisionSecret(name));
    expect(unprovisionable).toEqual([]);
  });

  it('declares at least one secret, so the check above is not vacuous', () => {
    expect(declaredSecretNames().length).toBeGreaterThan(0);
  });

  it('has no generator left over from the project’s previous name', () => {
    // The other direction. A stale entry is not harmless the way an unreachable
    // branch is: it reads as coverage of a secret that no longer exists, and the
    // real one is then assumed to be handled by a neighbour.
    expect(provisionableSecretNames().filter((name) => name.includes('edge-git'))).toEqual([]);
  });

  it('has no generator the template stopped declaring', () => {
    expect(provisionableSecretNames().sort()).toEqual([...new Set(declaredSecretNames())].sort());
  });
});

describe('provisionSecretValue', () => {
  it('produces base64 of exactly 32 bytes, the size resolveReplicationKey demands', async () => {
    const value = provisionSecretValue('durable-dav-replication-encryption-key');
    expect(Buffer.from(value, 'base64')).toHaveLength(32);
    // The real contract, not a proxy for it: the value has to open an envelope
    // the Worker wrote. A generator that drifted to a different length or a
    // different alphabet would still pass a length check and strand every
    // stored remote credential.
    const envelope = await encryptReplicationSecret('remote-password', value);
    await expect(decryptReplicationSecret(envelope, value)).resolves.toBe('remote-password');
  });

  it('generates a different value each time', () => {
    expect(provisionSecretValue('durable-dav-replication-encryption-key')).not.toBe(
      provisionSecretValue('durable-dav-replication-encryption-key'),
    );
  });

  it('throws naming an unknown secret, rather than skipping it', () => {
    // Skipping would leave the binding unsatisfied and fail later at deploy,
    // with nothing naming the secret that could not be created.
    expect(() => provisionSecretValue('some-other-secret')).toThrow(/some-other-secret/);
  });

  it('does not treat an inherited object member as provisionable', () => {
    // A plain object literal indexed by a config-supplied name finds
    // `Object.prototype`; the lookup has to be own-key only.
    expect(canProvisionSecret('constructor')).toBe(false);
    expect(canProvisionSecret('toString')).toBe(false);
    expect(() => provisionSecretValue('constructor')).toThrow();
  });
});

describe('planSecrets', () => {
  it('collects the bindings the template declares', () => {
    expect(planSecrets(template)).toEqual(
      declaredSecretNames().map((secretName) => ({
        storeId: expect.stringMatching(/^[a-f0-9]{32}$/i),
        secretName,
      })),
    );
  });

  it('is empty when the template declares no secrets', () => {
    expect(planSecrets({})).toEqual([]);
    expect(planSecrets({ secrets_store_secrets: [] })).toEqual([]);
  });

  it('rejects a binding with no store_id, rather than listing against undefined', () => {
    expect(() => planSecrets({ secrets_store_secrets: [{ binding: 'X', secret_name: 'y' }] })).toThrow(/store_id/);
  });

  it('rejects a binding with no secret_name', () => {
    expect(() => planSecrets({ secrets_store_secrets: [{ binding: 'X', store_id: 'a'.repeat(32) }] })).toThrow(/secret_name/);
  });

  it('validates every binding before the first one is acted on', () => {
    // Order matters: validating lazily means the first secret is created and the
    // second then throws, leaving a half-provisioned store that reports a
    // failure while having made a real change to the account.
    expect(() =>
      planSecrets({
        secrets_store_secrets: [
          { binding: 'good', store_id: 'a'.repeat(32), secret_name: 'durable-dav-replication-encryption-key' },
          { binding: 'bad', store_id: 'b'.repeat(32), secret_name: 'unprovisionable' },
        ],
      }),
    ).toThrow(/unprovisionable/);
  });
});

describe('parseSecretNames', () => {
  it('reads the name column and skips the header and the frame', () => {
    expect(parseSecretNames(secretTable('durable-dav-replication-encryption-key', 'another-secret'))).toEqual([
      'durable-dav-replication-encryption-key',
      'another-secret',
    ]);
  });

  it('returns nothing for an empty response', () => {
    expect(parseSecretNames('')).toEqual([]);
    expect(parseSecretNames('🔐 Listing secrets... (store-id: abc, page: 1, per-page: 100)')).toEqual([]);
  });

  it('matches whole names, so a longer secret cannot stand in for a shorter one', () => {
    // The previous check was `output.includes(secretName)` over the raw table.
    // A store holding only `…-key-backup` satisfied it, and the real secret was
    // left uncreated while the step reported success.
    const names = parseSecretNames(secretTable('durable-dav-replication-encryption-key-backup'));
    expect(names).toEqual(['durable-dav-replication-encryption-key-backup']);
    expect(names.includes('durable-dav-replication-encryption-key')).toBe(false);
  });
});

describe('a failed run exits non-zero', () => {
  it('fails the step instead of reporting a provisioning failure as success', () => {
    // `main().catch(console.error)` exits 0 — `console.error` returns `undefined`
    // and never sets an exit status — which is how a broken provisioner stayed
    // green while breaking the deploy. Run from a directory holding a config
    // that declares an unprovisionable secret, so the failure happens before any
    // Cloudflare call and the test needs no credentials.
    const cwd = mkdtempSync(path.join(tmpdir(), 'dav-init-secrets-'));
    try {
      writeFileSync(
        path.join(cwd, 'wrangler.jsonc'),
        JSON.stringify({
          name: 'probe',
          secrets_store_secrets: [{ binding: 'PROBE', store_id: 'a'.repeat(32), secret_name: 'unprovisionable' }],
        }),
      );
      // `tsx`'s CLI resolved to an absolute path rather than looked up on `PATH`:
      // a name off `PATH` would run whatever the surrounding environment happens
      // to put there, which is not something a test should do even to prove a
      // point.
      const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('tsx/cli'), initSecretsScript], {
        cwd,
        encoding: 'utf8',
      });
      // Only the child's own error line goes into the assertion message. Handing
      // vitest the raw output made it try to resolve the `…/init-secrets.ts:1:1`
      // stack frames as sources, and its source-map reader crashed on them —
      // so the one test whose whole job is to prove a failure is *reported*
      // failed by taking the reporter down with it.
      const detail = `${result.stdout}${result.stderr}`
        .split('\n')
        .find((line) => line.trimStart().startsWith('Error:'));
      expect(result.status, `child reported: ${detail ?? '(nothing)'}`).toBe(1);
      expect(result.stderr).toContain('unprovisionable');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});