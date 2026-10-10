#!/usr/bin/env tsx
/**
 * Ops: report replication targets whose stored credential cannot be read.
 *
 * ## Why this exists
 *
 * `createReplication` and `rotateSecret` validated that a `username` was present for
 * `authKind: 'basic'` and then sealed the bare password without it. `buildRemote`
 * splits the decrypted blob on the first `:` and refuses one without. So every `basic`
 * replication created through the API stored a colon-free credential, and every sync
 * failed with "stored replication credential is malformed" — an error whose own
 * advice ("rotate it") re-sealed the same bare password and failed identically.
 *
 * The fix composes the username on write. It **cannot** repair rows that were already
 * written: the username was never stored anywhere, so it cannot be recovered, only
 * re-entered. This script answers the question that decides whether an operator needs
 * to tell anyone to re-enter a credential — and it is read-only, so running it against
 * production changes nothing.
 *
 * ## What it reports
 *
 * For each `basic` target: whether the envelope decrypts at all, and whether the
 * plaintext carries a `user:` prefix. Three outcomes, and the middle one is the bug:
 *
 * - `ok`         — has a prefix. Nothing to do.
 * - `needs-username` — decrypts, no colon. Written by the broken build. Re-enter the
 *   credential; no password reset is required, only the username plus the same
 *   password re-supplied together.
 * - `undecryptable` — the key does not open it. A *key* problem, not a credential
 *   one, and rotating will not help; see the note below.
 *
 * `undecryptable` is reported separately and deliberately. It is the same error the
 * sweep reports as "could not be decrypted with REPLICATION_ENCRYPTION_KEY", and it
 * has a different remedy: the key was rotated, or the row predates it. Re-entering a
 * credential seals with the *current* key and would fix those rows too — so the fix
 * is the same, but the diagnosis an operator gives the owner is not.
 *
 * Nothing here decrypts a credential it did not have to: the plaintext is inspected
 * for a single character and never printed. A username is not a secret, but the blob
 * also contains the password, and a diagnostic that prints it would end up in a
 * terminal scrollback and a CI log.
 *
 * Usage:
 *   pnpm exec tsx scripts/replication-credential-audit.ts --db durable-dav-db [--remote]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decryptReplicationSecret } from '../packages/backend-data/src/crypto/aes-gcm';

interface Args {
  db?: string;
  config: string;
  persistTo?: string;
  remote: boolean;
  json: boolean;
  help: boolean;
}

const USAGE = `Usage:
  pnpm exec tsx scripts/replication-credential-audit.ts --db <name> [--remote] [--json]

Flags:
  --db <name>       D1 database name or binding (required)
  --config <path>   wrangler config (default ./wrangler.jsonc)
  --persist-to <d>  local persistence dir (only with --local)
  --remote          run against the remote database (default: local)
  --json            machine-readable output
  --help            this text

Read-only. Never prints a stored credential or its plaintext.
`;

function parseArgs(argv: string[]): Args {
  const out: Args = { config: './wrangler.jsonc', remote: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--db') out.db = next();
    else if (arg === '--config') out.config = next();
    else if (arg === '--persist-to') out.persistTo = next();
    else if (arg === '--remote') out.remote = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

interface QueryResult {
  results?: Array<Record<string, unknown>>;
}

/**
 * A value for SQLite, restricted to a database name or binding.
 *
 * This script interpolates only into `--command`, and the allowlist is the safety
 * property: a name that is not a plain identifier is refused rather than quoted.
 */
function sqlName(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) die(`refusing to interpolate ${JSON.stringify(value)}: not a plain database name`);
  return value;
}

function d1(args: Args, sql: string): QueryResult {
  const commandArgs = [
    'exec',
    'wrangler',
    'd1',
    'execute',
    sqlName(args.db as string),
    '--command',
    sql,
    '--config',
    args.config,
    '--json',
    ...(args.remote ? ['--remote'] : ['--local', ...(args.persistTo ? ['--persist-to', args.persistTo] : [])]),
  ];
  const result = spawnSync('pnpm', commandArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) die(`wrangler d1 execute failed:\n${(result.stderr || result.stdout || '').trim()}`);
  const stdout = (result.stdout || '').trim();
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1) die(`unexpected wrangler output: ${stdout.slice(0, 400)}`);
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) return (parsed[0] as QueryResult | undefined) ?? {};
  } catch {
    die(`could not parse wrangler output: ${stdout.slice(0, 400)}`);
  }
  return {};
}

type Verdict = 'ok' | 'needs-username' | 'undecryptable' | 'no-credential';

interface Finding {
  replicationId: string;
  volume: string;
  remoteUrl: string;
  authKind: string;
  verdict: Verdict;
}

/**
 * The encryption key, if the operator has it locally.
 *
 * A Secrets Store binding is not readable from a shell, so this script cannot
 * distinguish "wrong key" from "no key". Both land in `undecryptable`, which is the
 * honest answer — and the remedy is the same either way: re-enter the credential,
 * which seals it with whatever key the Worker is actually using.
 */
function readKey(config: string): string | undefined {
  const fromEnv = process.env['REPLICATION_ENCRYPTION_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { vars?: Record<string, unknown> };
    const value = parsed.vars?.['REPLICATION_ENCRYPTION_KEY'];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.db) die('--db is required');

  const rows = d1(
    args,
    `SELECT r.replication_id, r.auth_kind, r.remote_url, r.remote_owner, r.remote_volume,
            v.owner, v.name AS volume_name, r.encrypted_secret, r.secret_iv
       FROM dav_replications r
       JOIN dav_volumes v ON v.id = r.volume_id
      WHERE r.auth_kind IN ('basic', 'bearer')
      ORDER BY v.owner, v.name;`,
  ).results ?? [];

  const key = readKey(args.config);
  const findings: Finding[] = rows.map((row) => {
    const authKind = String(row['auth_kind']);
    const base = {
      replicationId: String(row['replication_id']),
      volume: `${String(row['owner'])}/${String(row['volume_name'])}`,
      remoteUrl: String(row['remote_url']),
      authKind,
    };
    const ciphertext = row['encrypted_secret'];
    const iv = row['secret_iv'];
    if (typeof ciphertext !== 'string' || typeof iv !== 'string') return { ...base, verdict: 'no-credential' as Verdict };
    // Without a key every basic row would read as `undecryptable`, which would make
    // the report useless rather than merely incomplete.
    if (key === undefined) return { ...base, verdict: 'undecryptable' as Verdict };
    let plaintext: string;
    try {
      plaintext = decryptReplicationSecret({ ciphertext, iv }, key);
    } catch {
      return { ...base, verdict: 'undecryptable' as Verdict };
    }
    // The whole test. Only `basic` needs the prefix; a bearer token legitimately has
    // no colon and is reported `ok` regardless.
    return { ...base, verdict: authKind === 'basic' && !plaintext.includes(':') ? ('needs-username' as Verdict) : ('ok' as Verdict) };
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ scanned: rows.length, keyAvailable: key !== undefined, findings }, null, 2)}\n`);
  } else {
    if (key === undefined) {
      process.stdout.write(
        'note: REPLICATION_ENCRYPTION_KEY is not available to this process (a Secrets Store binding is not readable from a shell).\n' +
          '      Every credential row is reported "undecryptable" because it could not be opened, not because it is broken.\n\n',
      );
    }
    if (findings.length === 0) process.stdout.write('No basic or bearer replication targets found.\n');
    for (const finding of findings) {
      process.stdout.write(`${finding.verdict.padEnd(16)} ${finding.volume}  ${finding.remoteUrl}\n`);
    }
    const broken = findings.filter((finding) => finding.verdict === 'needs-username');
    const locked = findings.filter((finding) => finding.verdict === 'undecryptable');
    process.stdout.write(`\n${findings.length} scanned, ${broken.length} need a username re-entered, ${locked.length} could not be decrypted.\n`);
    if (broken.length > 0) {
      process.stdout.write(
        '\nRemedy: re-enter the username AND password for each target above, via\n' +
          '  POST /user/volumes/:owner/:volume/replications/:id/credential\n' +
          '  {"authKind":"basic","username":"...","secret":"..."}\n' +
          'or the "Update Credential" control in the bucket settings.\n' +
          'The existing password is unchanged — it was stored correctly; only the\n' +
          'username was dropped. Rotating without a username will not help.\n',
      );
    }
  }
}

main();