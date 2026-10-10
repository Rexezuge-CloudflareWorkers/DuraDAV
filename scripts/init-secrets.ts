#!/usr/bin/env tsx

/**
 * Provisioning the Secrets Store values that `wrangler deploy` binds.
 *
 * ## Why this script exists at all
 *
 * `REPLICATION_ENCRYPTION_KEY_SECRET` is a `secrets_store_secrets` binding, so
 * the deploy fails unless the named secret already exists inside the named
 * store. Nothing creates it: Cloudflare will not generate a value, and the
 * template cannot carry one. That makes this script the only thing standing
 * between a fresh account and a deploy that cannot succeed.
 *
 * ## The two defects that hid a broken deploy for a whole release
 *
 * **The generator list was stale.** This file carried the allowlist from the
 * project it was inherited from — five `edge-git-*-encryption-key` names and
 * `edge-git-action-signing-secret`, all deleted when the repository was renamed
 * to Durable-DAV. `durable-dav-replication-encryption-key` matched none of them,
 * so the script threw `Unknown secret` on its very first iteration and never
 * created anything.
 *
 * **The throw was swallowed.** The last line used to be
 * `main().catch(console.error)`. `console.error` returns `undefined` and never
 * sets an exit status, so the process exited **0** and CI marked the step green.
 * The failure only surfaced one step later, as an unexplainable `wrangler
 * deploy` failure — three retries against a secret that had never been created
 * and a step that had reported success while creating nothing. That is the
 * whole reason the plan below is validated before any Cloudflare call: a
 * provisioning script that cannot report its own failure is worse than none.
 *
 * ## Create-if-absent is a correctness property, not laziness
 *
 * An existing secret is left untouched. `durable-dav-replication-encryption-key`
 * seals every remote target's credential; regenerating it on a redeploy would
 * strand every one of those credentials as undecryptable. Rotation has to be a
 * deliberate act with a re-encrypt path, not a side effect of deploying.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
// The same generator the Worker-side `resolveReplicationKey` contract is written
// against: base64 of exactly 32 bytes. Imported rather than reimplemented
// because a second definition of "what a replication key looks like" is the
// failure mode this whole file is about.
import { generateReplicationKey } from '@durable-dav/backend-data/crypto/aes-gcm';

interface WranglerConfig {
  secrets_store_secrets?: Array<{
    binding?: string;
    store_id?: string;
    secret_name?: string;
  }>;
}

/**
 * Which secret names this script can produce a value for, and how.
 *
 * A `Map`, not an object literal: indexing a plain object with a config-supplied
 * string would find `Object.prototype` members, so a template naming a secret
 * `"constructor"` would appear provisionable and then call `Object` as a
 * function.
 */
const SECRET_GENERATORS = new Map<string, () => string>([
  ['durable-dav-replication-encryption-key', generateReplicationKey],
]);

/**
 * `wrangler secrets-store secret list` renders a `cli-table3` table and offers no
 * `--json`. Default page size is 10, so a store holding more than ten secrets
 * would report every one of the rest as absent — and the subsequent `create`
 * would then fail with "already exists", permanently and confusingly.
 */
const LIST_PAGE_SIZE = 100;

/**
 * A ceiling on the paging loop. Wrangler gives no total count to page against,
 * and an unbounded loop in CI is a hang rather than a failure.
 */
const MAX_LIST_PAGES = 20;

/**
 * Wrangler exits non-zero on an *empty* store — "List request returned no
 * secrets." — because the command has no "zero rows" exit code. That one message
 * means "absent"; every other non-zero exit is a real fault and must not be
 * mistaken for permission to create.
 */
const EMPTY_STORE_MARKER = 'List request returned no secrets';

export interface PlannedSecret {
  storeId: string;
  secretName: string;
}

/**
 * Parse the first column out of a `cli-table3` table.
 *
 * Exact cell values, never `output.includes(name)`: a store holding both
 * `durable-dav-replication-encryption-key` and some `…-key-backup` would satisfy
 * a substring search for the first, and the script would leave the real secret
 * uncreated while reporting it done.
 *
 * cli-table3 separates data rows with `│` but header/separator rows with `┼`,
 * so the `│` test drops the frame before any cell is read.
 */
export function parseSecretNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes('│')) {
      continue;
    }
    const [name] = line
      .split('│')
      .map((cell) => cell.trim())
      .filter(Boolean);
    // `filter(Boolean)` drops the empty leading/trailing padding cells, so an
    // all-frame line yields nothing and destructures to undefined.
    if (name && name !== 'Name' && !name.includes('─')) {
      names.push(name);
    }
  }
  return names;
}

/** Whether this script knows how to produce a value for `secretName`. */
export function canProvisionSecret(secretName: string): boolean {
  return SECRET_GENERATORS.has(secretName);
}

/** The names this script can provision, for the guard test that keeps both sides in step. */
export function provisionableSecretNames(): string[] {
  return [...SECRET_GENERATORS.keys()];
}

/** Generate a fresh value for a known secret name. Throws, naming the secret, for an unknown one. */
export function provisionSecretValue(secretName: string): string {
  const generate = SECRET_GENERATORS.get(secretName);
  if (!generate) {
    throw new Error(
      `No generator for secret "${secretName}". Add one to SECRET_GENERATORS in scripts/init-secrets.ts, ` +
        'or provision the value out of band.',
    );
  }
  return generate();
}

function parseWranglerConfig(): WranglerConfig {
  const configPath = join(process.cwd(), 'wrangler.jsonc');
  return parse(readFileSync(configPath, 'utf8')) as WranglerConfig;
}

/**
 * Turn the template's bindings into a validated work list.
 *
 * Every entry is checked *before* the first Cloudflare call, so an
 * unprovisionable secret fails the step in milliseconds instead of after some
 * other secret has already been created.
 */
export function planSecrets(config: WranglerConfig): PlannedSecret[] {
  const plan: PlannedSecret[] = [];
  for (const [index, secret] of (config.secrets_store_secrets ?? []).entries()) {
    const label = secret.binding ?? `index ${index}`;
    const { store_id: storeId, secret_name: secretName } = secret;
    if (!storeId || !secretName) {
      throw new Error(
        `secrets_store_secrets[${index}] ("${label}") needs both store_id and secret_name; ` +
          'store_id is normally filled in by scripts/prepare-wrangler-config.ts.',
      );
    }
    if (!canProvisionSecret(secretName)) {
      throw new Error(
        `No generator for secret "${secretName}" (binding "${label}"). ` +
          'Add one to SECRET_GENERATORS in scripts/init-secrets.ts, or remove the binding.',
      );
    }
    plan.push({ storeId, secretName });
  }
  return plan;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `wrangler` through an argv array with piped stdio — never `sh -c`, so the
 * store id and secret name never reach a shell and a value is never passed on a
 * command line where `ps` could read it.
 */
function runWrangler(args: readonly string[], input?: string): CommandResult {
  const child = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    input,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    ok: child.status === 0,
    stdout: child.stdout ?? '',
    stderr: child.stderr || child.error?.message || '',
  };
}

/**
 * Whether `secretName` already exists in `storeId`.
 *
 * A non-zero exit is only read as "absent" when it carries `EMPTY_STORE_MARKER`.
 * Treating every failure as "absent" would let a bad token or an unreachable
 * API masquerade as an empty store and send the script straight into a `create`
 * that fails for a reason that has nothing to do with the secret.
 */
export function secretExists(storeId: string, secretName: string): boolean {
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const result = runWrangler(
      ['secrets-store', 'secret', 'list', storeId, '--remote', '--per-page', String(LIST_PAGE_SIZE), '--page', String(page)],
    );
    if (!result.ok) {
      if (`${result.stdout}${result.stderr}`.includes(EMPTY_STORE_MARKER)) {
        return false;
      }
      throw new Error(
        `wrangler secrets-store secret list ${storeId} --page ${page} failed:\n${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const names = parseSecretNames(result.stdout);
    if (names.includes(secretName)) {
      return true;
    }
    // A short page is the last page.
    if (names.length < LIST_PAGE_SIZE) {
      return false;
    }
  }
  throw new Error(
    `Secret "${secretName}" not found in store ${storeId} within the first ${MAX_LIST_PAGES} pages ` +
      `(${MAX_LIST_PAGES * LIST_PAGE_SIZE} secrets). Raise LIST_PAGE_SIZE/MAX_LIST_PAGES rather than creating a duplicate.`,
  );
}

function createSecret(storeId: string, secretName: string, secretValue: string): void {
  console.log(`Creating secret: ${secretName}`);
  // Why `spawnSync` with piped stdin: the previous
  // `echo "${secretValue}" | wrangler ... ${secretName}` broke on `"`, `$`,
  // backticks, and newlines and leaked the value via `ps`. Argv + stdin pipe
  // keeps both the value and the names out of any shell.
  const result = runWrangler(
    ['secrets-store', 'secret', 'create', storeId, '--name', secretName, '--scopes', 'workers', '--remote'],
    secretValue,
  );
  if (!result.ok) {
    throw new Error(
      `wrangler secrets-store secret create ${storeId} --name ${secretName} failed:\n${
        result.stderr.trim() || result.stdout.trim() || 'Unknown error.'
      }`,
    );
  }
}

async function main(): Promise<void> {
  console.log('Initializing Cloudflare secrets...');
  const plan = planSecrets(parseWranglerConfig());
  for (const { storeId, secretName } of plan) {
    if (secretExists(storeId, secretName)) {
      // Never re-created: the existing value still seals every stored remote
      // credential. Replacing it on a redeploy would strand all of them.
      console.log(`Secret ${secretName} already exists; leaving it untouched.`);
      continue;
    }
    createSecret(storeId, secretName, provisionSecretValue(secretName));
    console.log(`Created secret: ${secretName}`);
  }
  console.log('Secret initialization complete');
}

// Guarded so a test can import the pure helpers above without this shelling out
// to wrangler at import time. `process.exitCode` rather than `process.exit(1)`
// so the failure is reported after the output above has flushed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };