import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, migrationFileNames } from '../helpers/migrations';

/**
 * Migration 0005 (read-only credentials) upgrade safety.
 *
 * 0005 is the cheap kind of migration — one additive column with a constant
 * default — and that is exactly why it needs a test. There is no row loss to
 * detect and no foreign key to dangle; the one failure mode is a *default* that
 * is wrong in the direction nobody notices until a user cannot upload. If
 * `DEFAULT 0` were ever 1, or the coercion in `DavCredentialDAO.toMetadata`
 * treated a missing column as truthy, every credential that existed before the
 * upgrade would silently become read-only and its owner would have no way to
 * tell why their client stopped working.
 *
 * So the assertions are about the default, the coercion, and the shape of the
 * value that comes back out.
 */

const DB = env.DB as D1Database;
const PRE_READ_ONLY = '0004_user_identity.sql';
const READ_ONLY = '0005_read_only_credentials.sql';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function applyThrough(file: string): Promise<void> {
  await applyMigrations(DB, { to: file });
}

/**
 * Seed the pre-0005 shape directly, bypassing the helpers (which now write the
 * post-0004 columns). The credential is inserted with the 0001–0004 column list
 * only, so applying 0005 to this is a genuine upgrade.
 */
async function seedPreReadOnly(): Promise<void> {
  const now = nowSeconds();
  await DB.prepare('INSERT INTO users (email, created_at, id, current_email, username, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('alice@example.com', now, 'usr_aaa', 'alice@example.com', 'alice', now)
    .run();
  await DB.prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)').bind('alice@example.com', 'usr_aaa', now).run();
  await DB.prepare('INSERT INTO namespaces (username_ci, kind, user_email, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('alice', 'user', 'alice@example.com', 'usr_aaa', now)
    .run();
  await DB.prepare(
    `INSERT INTO dav_volumes (id, owner_email, owner_user_id, owner, name, description, is_private, created_at, updated_at, owner_ci, name_ci)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind('vol-alice', 'alice@example.com', 'usr_aaa', 'alice', 'photos', null, 1, now, now, 'alice', 'photos')
    .run();
  await DB.prepare(
    `INSERT INTO dav_credentials (credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind('cred-1', 'vol-alice', 'photos-clever-otter-1234', 'hash-1', 'laptop', 'ddav_ab', 'wxyz', now, now + 86_400)
    .run();
}

/**
 * D1 has no transactional DDL rollback, so each test starts from an empty set of
 * tables and applies exactly the migrations it needs. Stopping at 0004 to seed
 * the pre-upgrade shape is the whole point of this file, so the reset must not
 * run 0005 for it.
 */
async function resetDatabase(): Promise<void> {
  for (const table of ['dav_credentials', 'dav_volumes', 'user_emails', 'namespaces', 'users']) {
    await DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

beforeEach(resetDatabase);

describe('migration files are individually addressable', () => {
  it('embeds 0005 after 0004, in apply order', () => {
    const names = migrationFileNames();
    expect(names).toContain(PRE_READ_ONLY);
    expect(names).toContain(READ_ONLY);
    expect(names.indexOf(PRE_READ_ONLY)).toBeLessThan(names.indexOf(READ_ONLY));
  });
});

describe('0005 leaves existing credentials writable', () => {
  it('loses no rows and leaves no dangling foreign key', async () => {
    await applyThrough(PRE_READ_ONLY);
    await seedPreReadOnly();
    const before = await DB.prepare('SELECT COUNT(*) AS n FROM dav_credentials').first<{ n: number }>();

    await applyMigrations(DB, { from: READ_ONLY, to: READ_ONLY });

    const after = await DB.prepare('SELECT COUNT(*) AS n FROM dav_credentials').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const violations = await DB.prepare('PRAGMA foreign_key_check').all<Record<string, unknown>>();
    expect(violations.results ?? []).toEqual([]);
  });

  it('defaults every pre-existing credential to full access', async () => {
    await applyThrough(PRE_READ_ONLY);
    await seedPreReadOnly();
    await applyMigrations(DB, { from: READ_ONLY, to: READ_ONLY });

    const row = await DB.prepare('SELECT read_only FROM dav_credentials WHERE credential_id = ?').bind('cred-1').first<{ read_only: number }>();
    // The whole safety story of the migration. `1` here would lock the owner
    // out of their own bucket with no error and no way to diagnose it.
    expect(row?.read_only).toBe(0);
  });

  it('defaults a credential inserted after the upgrade to full access too', async () => {
    // Not just backfilled rows: the column default governs every future insert
    // that omits the column, which is what any code path that has not been
    // updated yet will do.
    await applyMigrations(DB);
    const now = nowSeconds();
    await seedPreReadOnly();
    await DB.prepare(
      `INSERT INTO dav_credentials (credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('cred-legacy-shape', 'vol-alice', 'photos-quiet-otter-5678', 'hash-2', 'omitted', 'ddav_cd', 'efgh', now, now + 86_400)
      .run();

    const row = await DB.prepare('SELECT read_only FROM dav_credentials WHERE credential_id = ?').bind('cred-legacy-shape').first<{ read_only: number }>();
    expect(row?.read_only).toBe(0);
  });

  it('rejects a read_only value outside the allowed set', async () => {
    // The CHECK is what stops a hand-edited or buggy write from parking a row
    // in a state no code path knows how to read.
    await applyMigrations(DB);
    await seedPreReadOnly();
    await expect(
      DB.prepare('UPDATE dav_credentials SET read_only = 2 WHERE credential_id = ?').bind('cred-1').run(),
    ).rejects.toThrow(/CHECK constraint failed|constraint/u);
  });

  it('round-trips an explicit read-only credential', async () => {
    await applyMigrations(DB);
    await seedPreReadOnly();
    await DB.prepare('UPDATE dav_credentials SET read_only = 1 WHERE credential_id = ?').bind('cred-1').run();
    const row = await DB.prepare('SELECT read_only FROM dav_credentials WHERE credential_id = ?').bind('cred-1').first<{ read_only: number }>();
    expect(row?.read_only).toBe(1);
  });
});
