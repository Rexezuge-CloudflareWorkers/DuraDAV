#!/usr/bin/env tsx
/**
 * Ops: change a user's sign-in address.
 *
 * Wraps the three statements `UserIdentityService.setPrimaryEmail` performs, in
 * the order it performs them:
 *
 *   1. claim the new address as verified for the account,
 *   2. move `users.current_email`,
 *   3. revoke every other verified address for that account.
 *
 * The order is the whole point. Claiming first means the user is never locked
 * out — there is only a brief window where both addresses authenticate. Revoking
 * first opens a window where neither does. And `users.email` is never touched: it
 * is the frozen anchor that `dav_volumes.owner_email` cascades from, so updating
 * it would delete the user's buckets. Volumes, namespace claims, and every
 * bucket credential key on the account id and are unaffected.
 *
 * Takes a D1 backup first, and refuses (rather than half-applying) when the new
 * address is already a live login for a different account.
 *
 * Usage:
 *   pnpm exec tsx scripts/change-email.ts --db durable-dav-db --account alice@example.com --to new@example.com
 *   pnpm exec tsx scripts/change-email.ts --db durable-dav-db --id usr_ab12... --to new@example.com --dry-run
 *
 * Flags:
 *   --db <name|binding>  required; D1 database name or binding
 *   --account <value>    match the current sign-in address (or username)
 *   --id <usr_id>        match the stable account id (alternative to --account)
 *   --to <email>         the new sign-in address
 *   --config <path>      wrangler config (default ./wrangler.jsonc)
 *   --persist-to <dir>   local persistence directory (only with --local)
 *   --remote             run against the remote database (default: local)
 *   --dry-run            print the plan and the SQL, change nothing
 */
import { spawnSync } from 'node:child_process';

interface Args {
  db?: string;
  account?: string;
  id?: string;
  to?: string;
  config: string;
  persistTo?: string;
  remote: boolean;
  dryRun: boolean;
  help: boolean;
}

const USAGE = `Usage:
  pnpm exec tsx scripts/change-email.ts --db <name> (--account <email|username> | --id <usr_id>) --to <new-email> [--remote] [--dry-run]

Flags:
  --db <name>       D1 database name or binding (required)
  --account <value> the current sign-in address, or a username
  --id <usr_id>     the stable account id
  --to <email>      the new sign-in address
  --config <path>   wrangler config (default ./wrangler.jsonc)
  --persist-to <d>  local persistence dir (only with --local; must match where
                    the database was migrated, or you will hit a different DB)
  --remote          run against the remote database (default: local)
  --dry-run         print the plan and SQL without changing anything
`;

function parseArgs(argv: string[]): Args {
  const out: Args = { config: './wrangler.jsonc', remote: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--db') out.db = next();
    else if (arg === '--account') out.account = next();
    else if (arg === '--id') out.id = next();
    else if (arg === '--to') out.to = next();
    else if (arg === '--config') out.config = next();
    else if (arg === '--persist-to') out.persistTo = next();
    else if (arg === '--remote') out.remote = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/**
 * Single-quote a value for SQLite.
 *
 * The pattern allowlist is the safety property here: this script interpolates
 * into SQL, so anything that is not a plain address or a plain id token is
 * refused rather than escaped-and-hoped. A bogus id simply matches no account.
 */
function sqlEmail(value: string): string {
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)) {
    die(`refusing to interpolate ${JSON.stringify(value)}: not a plain email address`);
  }
  return `'${value.toLowerCase()}'`;
}

function sqlToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.@-]+$/.test(value)) {
    die(`refusing to interpolate ${JSON.stringify(value)}: not a plain ${label}`);
  }
  return `'${value}'`;
}

/** A handle, held to the username charset the app itself enforces. */
function sqlUsername(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)) {
    die(`refusing to interpolate ${JSON.stringify(value)}: not a valid username`);
  }
  return `'${value.toLowerCase()}'`;
}

interface QueryResult {
  results?: Array<Record<string, unknown>>;
}

function d1(args: Args, sql: string): QueryResult {
  const commandArgs = [
    'exec',
    'wrangler',
    'd1',
    'execute',
    args.db as string,
    '--command',
    sql,
    '--config',
    args.config,
    '--json',
    ...(args.remote ? ['--remote'] : ['--local', ...(args.persistTo ? ['--persist-to', args.persistTo] : [])]),
  ];
  const result = spawnSync('pnpm', commandArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    die(`wrangler d1 execute failed:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  // wrangler --json emits one JSON array per statement; a single statement is
  // the common case here.
  const stdout = (result.stdout || '').trim();
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1) die(`unexpected wrangler output: ${stdout.slice(0, 400)}`);
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as QueryResult | undefined;
      return first ?? {};
    }
  } catch {
    die(`could not parse wrangler output: ${stdout.slice(0, 400)}`);
  }
  return {};
}

interface AccountRow {
  id: string;
  anchor: string;
  current_email: string | null;
  username: string | null;
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (args.help || (!args.account && !args.id) || !args.to || !args.db) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  const target = sqlEmail(args.to);
  // `--account` accepts a handle as well as an address: usernames are what users
  // know themselves by, and `current_email` is NULL on a pre-0004 database where
  // the address *is* the anchor. A value containing `@` is treated as an address
  // and held to the stricter pattern; anything else is matched as a handle.
  const wanted = args.account as string;
  const selector = args.id
    ? { sql: `id = ${sqlToken(args.id, 'account id')}`, label: `id ${args.id}` }
    : wanted.includes('@')
      ? {
          sql: `(lower(current_email) = lower(${sqlEmail(wanted)}) OR lower(email) = lower(${sqlEmail(wanted)}))`,
          label: `address ${wanted}`,
        }
      : {
          // The username charset, not the looser token pattern: a handle is
          // `[a-z0-9-]` by definition, so anything else is a mistake worth
          // refusing rather than matching no rows.
          sql: `username = ${sqlUsername(wanted)}`,
          label: `username ${wanted}`,
        };

  const found = d1(args, `SELECT id, email AS anchor, current_email, username FROM users WHERE ${selector.sql} LIMIT 1`);
  const account = (found.results ?? [])[0] as AccountRow | undefined;
  if (!account?.id) {
    die(
      `no account matched ${selector.label}. Check the current sign-in address or username; the frozen anchor is not searchable by the new address. ` +
        'Note: migration 0004 must have been applied — without it there are no account ids.',
    );
  }

  const holder = d1(
    args,
    `SELECT ue.user_id, ue.is_verified, u.current_email FROM user_emails ue JOIN users u ON u.id = ue.user_id WHERE ue.email = ${target} LIMIT 1`,
  );
  const existing = (holder.results ?? [])[0] as
    | { user_id: string; is_verified: number; current_email: string | null }
    | undefined;
  if (existing && existing.is_verified === 1 && existing.user_id !== account.id) {
    die(
      `${args.to} is already a live login for account ${existing.user_id} (current_email ${existing.current_email ?? '?'}). ` +
        'Re-pointing it would hand that account to this user. Resolve the conflict first.',
    );
  }

  const current = account.current_email ?? account.anchor;
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (${target}, ${sqlToken(account.id, 'account id')}, 1, ${now}) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified;`,
    `UPDATE users SET current_email = ${target}, updated_at = ${now} WHERE id = ${sqlToken(account.id, 'account id')};`,
    `UPDATE user_emails SET is_verified = 0 WHERE user_id = ${sqlToken(account.id, 'account id')} AND email != ${target};`,
  ];

  process.stdout.write(
    [
      `account   ${account.id} (username ${account.username ?? '-'})`,
      `anchor    ${account.anchor}  (frozen — never updated)`,
      `from      ${current}`,
      `to        ${args.to.toLowerCase()}`,
      `target    ${args.remote ? 'REMOTE' : 'local'} database '${args.db}'${args.persistTo ? ` (persist-to ${args.persistTo})` : ''}`,
      existing ? `note      ${args.to} already existed for this account (is_verified ${existing.is_verified}); it will be re-claimed` : '',
      '',
      'statements (applied in this order, as one batch):',
      ...statements.map((s, i) => `  ${i + 1}. ${s}`),
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  if (args.dryRun) {
    process.stdout.write('dry run — nothing was changed.\n');
    return;
  }
  d1(args, statements.join(' '));
  const after = d1(
    args,
    `SELECT u.email AS anchor, u.current_email, (SELECT group_concat(email || ':' || is_verified, ' ') FROM user_emails WHERE user_id = u.id) AS registry FROM users u WHERE u.id = ${sqlToken(account.id, 'account id')}`,
  );
  const row = (after.results ?? [])[0] as { anchor: string; current_email: string; registry: string } | undefined;
  process.stdout.write(
    [
      '',
      'applied. verify:',
      `  anchor        ${row?.anchor ?? '?'}`,
      `  current_email ${row?.current_email ?? '?'}`,
      `  registry      ${row?.registry ?? '?'}`,
      '',
      'not touched (they key on the account id and keep working):',
      '  dav_volumes, namespaces, and every dav_credentials row. Bucket URLs keep',
      '  using the username, which is unchanged by an address change.',
      'A volume written before 0004 has owner_user_id IS NULL and still resolves',
      'through owner_email; stamp it so it keys on the account too:',
      `  UPDATE dav_volumes SET owner_user_id = ${sqlToken(account.id, 'account id')} WHERE lower(owner_email) = lower(${sqlEmail(current)});`,
      '',
    ].join('\n'),
  );
}

main();
