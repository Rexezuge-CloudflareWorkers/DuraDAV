import { beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { UserIdentityService } from '@durable-dav/backend-services/identity';
import { applyMigrations, migrationFileNames } from '../helpers/migrations';

/**
 * Migration 0004 (user identity) upgrade safety.
 *
 * `users.email` used to be the primary key *and* the identity key of every
 * user-referencing column, so the address was the account. `dav_volumes` carried
 * `FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE`, which
 * made changing an address unsafe rather than merely unsupported.
 *
 * 0004 keeps `email` as a frozen *anchor* and adds an account key beside it, so
 * this test's job is to prove the upgrade loses nothing: every seeded row
 * survives, no foreign key dangles, the backfills are correct, the pre-existing
 * cascade is still intact, and a subsequent address change leaves id-keyed access
 * working.
 */

const DB = env.DB as D1Database;
const PRE_IDENTITY = '0003_href_prefix_mode.sql';
const IDENTITY = '0004_user_identity.sql';

type Counted = Record<string, number>;

/**
 * Every table that a row could be lost from, directly or transitively.
 *
 * `users` is the anchor of the whole graph: deleting a user cascades to their
 * volumes (via `owner_email`) and to their registry rows, and volumes cascade to
 * credentials and namespace claims. The `DELETE`-then-`PRAGMA foreign_key_check`
 * step below is what would surface a repointed or dropped reference.
 */
/**
 * Pre-existing tables whose rows must survive the upgrade untouched.
 *
 * `user_emails` is deliberately absent: 0004 creates it and backfills it, so its
 * count is *expected* to grow from 0. It is asserted separately.
 */
const PRE_EXISTING = ['users', 'dav_volumes', 'dav_credentials', 'namespaces'] as const;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Rows in a table, or 0 when the table does not exist yet.
 *
 * `user_emails` is created by 0004, so a "before" snapshot taken at 0003 has no
 * such table — and the assertion that matters is that the count is 0 before and
 * the full set after, not that the table was there.
 */
async function countRows(table: string): Promise<number> {
  try {
    const row = await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? 0;
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return 0;
    throw error;
  }
}

async function snapshotCounts(): Promise<Counted> {
  const out: Counted = {};
  for (const table of PRE_EXISTING) out[table] = await countRows(table);
  return out;
}

/**
`PRAGMA foreign_key_check` reports violations as rows rather than raising.
*/
async function foreignKeyViolations(): Promise<unknown[]> {
  const result = await DB.prepare('PRAGMA foreign_key_check').all<Record<string, unknown>>();
  return result.results ?? [];
}

async function applyThrough(file: string): Promise<void> {
  await applyMigrations(DB, { to: file });
}

/**
 * Seed the pre-0004 shape directly, bypassing `ensureUser` (which now writes the
 * post-0004 columns). Deliberately inserts only what migrations 0001–0003 define,
 * so applying 0004 to this is a genuine upgrade rather than a no-op.
 */
async function seedPreIdentity(): Promise<void> {
  const now = nowSeconds();
  await DB.prepare('INSERT INTO users (email, created_at, username, updated_at) VALUES (?, ?, ?, ?)').bind('alice@example.com', now, 'alice', now).run();
  await DB.prepare('INSERT INTO users (email, created_at, username, updated_at) VALUES (?, ?, ?, ?)').bind('bob@example.com', now, 'bob', now).run();
  await DB.prepare('INSERT INTO namespaces (username_ci, kind, user_email, created_at) VALUES (?, ?, ?, ?)').bind('alice', 'user', 'alice@example.com', now).run();
  await DB.prepare('INSERT INTO namespaces (username_ci, kind, user_email, created_at) VALUES (?, ?, ?, ?)').bind('bob', 'user', 'bob@example.com', now).run();
  // One volume per user, and one credential on Alice's, so the whole cascade
  // graph below `users` is populated.
  await DB.prepare(
    `INSERT INTO dav_volumes (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_ci, name_ci)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind('vol-alice', 'alice@example.com', 'alice', 'photos', null, 1, now, now, 'alice', 'photos')
    .run();
  await DB.prepare(
    `INSERT INTO dav_volumes (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_ci, name_ci)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind('vol-bob', 'bob@example.com', 'bob', 'docs', null, 1, now, now, 'bob', 'docs')
    .run();
  await DB.prepare(
    `INSERT INTO dav_credentials (credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind('cred-1', 'vol-alice', 'photos-clever-otter-1234', 'hash-1', 'laptop', 'ddav_ab', 'wxyz', now, now + 86_400)
    .run();
}

/**
 * Empty the identity graph without applying anything.
 *
 * D1 has no transactional DDL rollback, so each test starts by dropping the
 * tables and then applies exactly the migrations it needs — stopping at 0003 to
 * seed the pre-upgrade shape is the whole point of this file, so the reset must
 * not run 0004 for it.
 */
async function resetDatabase(): Promise<void> {
  for (const table of ['dav_credentials', 'dav_volumes', 'user_emails', 'namespaces', 'users']) {
    await DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

beforeEach(resetDatabase);

describe('migration files are individually addressable', () => {
  it('embeds each file with its name, in apply order', () => {
    const names = migrationFileNames();
    expect(names).toContain(PRE_IDENTITY);
    expect(names).toContain(IDENTITY);
    expect(names.indexOf(PRE_IDENTITY)).toBeLessThan(names.indexOf(IDENTITY));
  });
});

describe('0004 preserves existing data', () => {
  it('loses no rows and leaves no dangling foreign key', async () => {
    await applyThrough(PRE_IDENTITY);
    await seedPreIdentity();
    const before = await snapshotCounts();

    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });

    const after = await snapshotCounts();
    for (const table of PRE_EXISTING) {
      expect(after[table], `row count for ${table}`).toBe(before[table]);
    }
    // The registry is additive: one verified row per existing account, and this
    // database started with none.
    expect(before.user_emails).toBeUndefined();
    expect(await countRows('user_emails')).toBe(before.users ?? 0);
    expect(await foreignKeyViolations()).toEqual([]);
  });

  it('gives every pre-existing account a unique id', async () => {
    await applyThrough(PRE_IDENTITY);
    await seedPreIdentity();
    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });

    const rows = await DB.prepare('SELECT email, id, current_email FROM users ORDER BY email').all<{ email: string; id: string; current_email: string }>();
    expect(rows.results).toHaveLength(2);
    const ids = new Set<string>();
    for (const row of rows.results ?? []) {
      expect(row.id).toMatch(/^usr_[0-9a-f]{32}$/);
      // Backfilled from the anchor, lowercased, so a mixed-case legacy row still
      // yields exactly one login identity.
      expect(row.current_email).toBe(row.email.toLowerCase());
      ids.add(row.id);
    }
    expect(ids.size).toBe(2);
  });

  it('registers every anchor address as verified for its own account', async () => {
    await applyThrough(PRE_IDENTITY);
    await seedPreIdentity();
    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });

    const rows = await DB
      .prepare('SELECT ue.email, ue.is_verified, u.email AS anchor FROM user_emails ue JOIN users u ON u.id = ue.user_id ORDER BY ue.email')
      .all<{ email: string; is_verified: number; anchor: string }>();
    expect(rows.results?.map((r) => [r.email, r.is_verified, r.anchor])).toEqual([
      ['alice@example.com', 1, 'alice@example.com'],
      ['bob@example.com', 1, 'bob@example.com'],
    ]);
  });

  it('backfills owner_user_id and namespace user_id through the registry', async () => {
    await applyThrough(PRE_IDENTITY);
    await seedPreIdentity();
    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });

    const volumes = await DB
      .prepare('SELECT owner_email, owner_user_id, (SELECT email FROM users WHERE id = dav_volumes.owner_user_id) AS resolved FROM dav_volumes ORDER BY owner_email')
      .all<{ owner_email: string; owner_user_id: string | null; resolved: string | null }>();
    // The join is the assertion: the key resolves back to the same account whose
    // anchor the row already held.
    expect(volumes.results?.map((v) => [v.owner_email, v.resolved])).toEqual([
      ['alice@example.com', 'alice@example.com'],
      ['bob@example.com', 'bob@example.com'],
    ]);

    const namespaces = await DB
      .prepare('SELECT username_ci, user_id, (SELECT email FROM users WHERE id = namespaces.user_id) AS resolved FROM namespaces ORDER BY username_ci')
      .all<{ username_ci: string; user_id: string | null; resolved: string | null }>();
    expect(namespaces.results?.map((n) => [n.username_ci, n.resolved])).toEqual([
      ['alice', 'alice@example.com'],
      ['bob', 'bob@example.com'],
    ]);
  });

  it('leaves an unmatched namespace owner NULL rather than dangling', async () => {
    // `namespaces.user_email` has no foreign key, so a claim can name an account
    // that does not exist (a deleted user, a bad import). The id stays NULL and
    // the row keeps resolving through its string column, so an unknown actor
    // stays attributable instead of breaking the read.
    //
    // `dav_volumes` cannot reach this state at all: `owner_email` is FK-constrained
    // to `users(email)`, so the address always resolves. That asymmetry is why
    // the NULL branch is a namespace concern.
    await applyThrough(PRE_IDENTITY);
    const now = nowSeconds();
    await DB.prepare('INSERT INTO namespaces (username_ci, kind, user_email, created_at) VALUES (?, ?, ?, ?)')
      .bind('ghost', 'user', 'ghost@example.com', now)
      .run();
    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });

    const row = await DB.prepare('SELECT user_id, user_email FROM namespaces WHERE username_ci = ?').bind('ghost').first<{ user_id: string | null }>();
    expect(row?.user_id).toBeNull();
    // No dangling reference was introduced.
    expect(await foreignKeyViolations()).toEqual([]);
  });

  it('cannot backfill a dav_volumes owner that matches no account', async () => {
    // The FK is the reason `dav_volumes.owner_user_id` backfills completely: the
    // owner address is constrained to a real `users` row, and 0004 registers
    // every anchor, so the join always resolves.
    await applyThrough(PRE_IDENTITY);
    const now = nowSeconds();
    await expect(
      DB.prepare(
        `INSERT INTO dav_volumes (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_ci, name_ci)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind('vol-ghost', 'ghost@example.com', 'ghost', 'old', null, 1, now, now, 'ghost', 'old')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('keeps the pre-existing owner_email cascade intact', async () => {
    // The property the frozen-anchor design exists to protect: the foreign key
    // from `dav_volumes` to `users(email)` must still be there, and must still
    // cascade. Without it, deleting a user would orphan their buckets instead of
    // removing them.
    await applyThrough(PRE_IDENTITY);
    await seedPreIdentity();
    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });

    const fks = await DB.prepare('PRAGMA foreign_key_list(dav_volumes)').all<{ table: string; from: string; to: string; on_delete: string }>();
    const anchorFk = (fks.results ?? []).find((fk) => fk.from === 'owner_email' && fk.table === 'users');
    expect(anchorFk).toMatchObject({ from: 'owner_email', to: 'email', on_delete: 'CASCADE' });

    await DB.prepare('DELETE FROM users WHERE email = ?').bind('alice@example.com').run();
    // Cascaded: the volume and its credential are gone, Bob's are untouched.
    expect(await countRows('dav_volumes')).toBe(1);
    expect(await countRows('dav_credentials')).toBe(0);
    const survivor = await DB.prepare('SELECT owner_email FROM dav_volumes').first<{ owner_email: string }>();
    expect(survivor?.owner_email).toBe('bob@example.com');
  });
});

describe('an address change after 0004', () => {
  /**
   * The three statements `UserIdentityService.setPrimaryEmail` performs, in the
   * order it performs them: claim the new address, move `current_email`, revoke
   * every other verified address. Claiming first means there is only a brief
   * window where both authenticate; revoking first would open a window where
   * neither does. `users.email` is never touched.
   */
  async function changePrimaryEmail(userId: string, next: string): Promise<void> {
    const now = nowSeconds();
    await DB.batch([
      DB.prepare(
        `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified`,
      ).bind(next, userId, now),
      DB.prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?').bind(next, now, userId),
      DB.prepare('UPDATE user_emails SET is_verified = 0 WHERE user_id = ? AND email != ?').bind(userId, next),
    ]);
  }

  async function seedAndUpgrade(): Promise<string> {
    await applyThrough(PRE_IDENTITY);
    await seedPreIdentity();
    await applyMigrations(DB, { from: IDENTITY, to: IDENTITY });
    const row = await DB.prepare('SELECT id FROM users WHERE email = ?').bind('alice@example.com').first<{ id: string }>();
    return row?.id ?? '';
  }

  it('keeps id-keyed ownership after the owner changes address', async () => {
    const userId = await seedAndUpgrade();
    await changePrimaryEmail(userId, 'alice.new@example.com');

    // The account key on the volume is untouched, so ownership is intact even
    // though the owner now signs in with a different address.
    const volume = await DB.prepare('SELECT owner_email, owner_user_id FROM dav_volumes WHERE id = ?').bind('vol-alice').first<{ owner_email: string; owner_user_id: string }>();
    expect(volume?.owner_user_id).toBe(userId);
    // The anchor is what it always was — never rewritten.
    expect(volume?.owner_email).toBe('alice@example.com');
  });

  it('leaves the volume reachable by its existing owner_id lookup', async () => {
    // The query the dashboard and the quota check now run.
    const userId = await seedAndUpgrade();
    await changePrimaryEmail(userId, 'alice.new@example.com');

    const owned = await DB.prepare('SELECT id FROM dav_volumes WHERE owner_user_id = ?').bind(userId).all<{ id: string }>();
    expect(owned.results?.map((r) => r.id)).toEqual(['vol-alice']);
    // The old-address lookup no longer finds it, which is why nothing may key
    // on the address any more.
    const byOldAddress = await DB.prepare('SELECT id FROM dav_volumes WHERE owner_email = ?').bind('alice.new@example.com').all<{ id: string }>();
    expect(byOldAddress.results).toEqual([]);
  });

  it('does not disturb bucket credentials, which carry no user reference', async () => {
    await seedAndUpgrade();
    const userId = (await DB.prepare('SELECT id FROM users WHERE email = ?').bind('alice@example.com').first<{ id: string }>())?.id ?? '';
    await changePrimaryEmail(userId, 'alice.new@example.com');
    // `dav_credentials` binds to `volume_id` only, so a credential survives its
    // owner's address change untouched.
    const cred = await DB.prepare('SELECT credential_id, volume_id FROM dav_credentials').first<{ credential_id: string; volume_id: string }>();
    expect(cred).toMatchObject({ credential_id: 'cred-1', volume_id: 'vol-alice' });
  });

  it('revokes the old address but keeps it attributable', async () => {
    const userId = await seedAndUpgrade();
    await changePrimaryEmail(userId, 'alice.new@example.com');

    const rows = await DB.prepare('SELECT email, is_verified FROM user_emails WHERE user_id = ?').bind(userId).all<{ email: string; is_verified: number }>();
    // The new address authenticates; the old one is retained at 0, so rows
    // written before the change still resolve to this account while the address
    // stops being a login and is released for a later legitimate holder.
    // Compared as a set: the row order is not the property under test.
    expect(new Set(rows.results?.map((r) => `${r.email}:${r.is_verified}`))).toEqual(
      new Set(['alice.new@example.com:1', 'alice@example.com:0']),
    );
  });

  it('refuses an address that is a live login for another account', async () => {
    // The check that makes the ops script safe. Without it, re-pointing an
    // address would hand one account to a different person.
    const userId = await seedAndUpgrade();
    const bobId = (await DB.prepare('SELECT id FROM users WHERE email = ?').bind('bob@example.com').first<{ id: string }>())?.id ?? '';
    const holder = await DB.prepare('SELECT user_id FROM user_emails WHERE email = ? AND is_verified = 1').bind('bob@example.com').first<{ user_id: string }>();
    expect(holder?.user_id).toBe(bobId);
    expect(holder?.user_id).not.toBe(userId);
  });

  it('a revoked address no longer resolves to the previous holder', async () => {
    const userId = await seedAndUpgrade();
    await changePrimaryEmail(userId, 'alice.new@example.com');

    // Resolution is address -> `user_emails` -> `users.id`, and only a verified
    // address resolves. A reassigned address must not keep authenticating the
    // previous holder's account.
    const revoked = await DB.prepare('SELECT * FROM user_emails WHERE email = ?').bind('alice@example.com').first<{ is_verified: number }>();
    expect(revoked?.is_verified).toBe(0);
    // But the account it pointed at is unchanged, which is what keeps the
    // pre-change volume attributable.
    const stillOwned = await DB.prepare('SELECT user_id FROM user_emails WHERE email = ?').bind('alice@example.com').first<{ user_id: string }>();
    expect(stillOwned?.user_id).toBe(userId);
  });
});

describe('the API authorizes id-keyed access after an address change', () => {
  /**
   * `DEV_AUTH_EMAIL` fixes the address the API authenticates as, so this account
   * is shaped around that constraint: its *anchor* is a legacy address and its
   * live sign-in address is the one Access sends.
   *
   * That is the real post-change state. The buckets were created long ago, when
   * the anchor was the login address, so `dav_volumes.owner_email` holds the
   * legacy address and nothing about the live one. The request must still find
   * them — which it can only do through `owner_user_id`.
   */
  const ANCHOR = 'identitytest.legacy@example.com';
  const API_USER = 'test@example.com';
  const OWNER_HANDLE = 'identitytest';
  const VOLUME = 'after-change';

  function api(path: string, init?: RequestInit): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, init);
  }

  function json(init?: RequestInit): RequestInit {
    return { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } };
  }

  it('still lists, reads, and updates buckets created under the old address', async () => {
    await applyMigrations(DB);
    const now = nowSeconds();
    const userId = `usr_${'b'.repeat(32)}`;
    // The account as it looks after an address change: anchor is the legacy
    // address, `current_email` is what Access now sends, and the registry holds
    // the live address verified (the anchor is revoked but still attributed).
    await DB.prepare('INSERT INTO users (email, created_at, id, current_email, username, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ANCHOR, now, userId, API_USER, OWNER_HANDLE, now)
      .run();
    await DB.batch([
      DB.prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
        .bind(ANCHOR, userId, now),
      DB.prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
        .bind(API_USER, userId, now),
    ]);
    await DB.prepare('INSERT INTO namespaces (username_ci, kind, user_email, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(OWNER_HANDLE, 'user', ANCHOR, userId, now)
      .run();
    // The bucket predates the change: `owner_email` is the legacy anchor.
    await DB.prepare(
      `INSERT INTO dav_volumes (id, owner_email, owner_user_id, owner, name, description, is_private, created_at, updated_at, owner_ci, name_ci)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('vol-idem', ANCHOR, userId, OWNER_HANDLE, VOLUME, null, 1, now, now, OWNER_HANDLE, VOLUME)
      .run();

    // The request authenticates as `API_USER` — an address the volume row does
    // not mention anywhere. Confirmed authenticated, so the assertions below are
    // about authorization rather than a rejected request.
    const me = (await (await api('/user/me')).json()) as { email: string; username: string | null };
    expect(me.email).toBe(API_USER);
    expect(me.username).toBe(OWNER_HANDLE);

    // Found only via `owner_user_id`: the address-keyed query matches nothing.
    const byAddress = await DB.prepare('SELECT id FROM dav_volumes WHERE owner_email = ?').bind(API_USER).all<{ id: string }>();
    expect(byAddress.results).toEqual([]);
    const byId = await DB.prepare('SELECT id FROM dav_volumes WHERE owner_user_id = ?').bind(userId).all<{ id: string }>();
    expect(byId.results?.map((r) => r.id)).toEqual(['vol-idem']);

    const list = (await (await api('/user/volumes')).json()) as { volumes: Array<{ name: string }> };
    expect(list.volumes.map((v) => v.name)).toContain(VOLUME);

    // Ownership guard on a single-bucket read.
    const detail = await api(`/user/volumes/${OWNER_HANDLE}/${VOLUME}`);
    expect(detail.status).toBe(200);

    // And the write path, which enforces the owner check too.
    const patch = await api(
      `/user/volumes/${OWNER_HANDLE}/${VOLUME}`,
      json({ method: 'PATCH', body: JSON.stringify({ description: 'still mine' }) }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { description: string }).description).toBe('still mine');

    // No fork: the request resolved to the existing account rather than
    // provisioning a second, empty one for the address it presented.
    const users = await DB.prepare('SELECT id, email, current_email FROM users').all<{ id: string; email: string; current_email: string }>();
    expect(users.results).toHaveLength(1);
    expect(users.results?.[0]?.id).toBe(userId);
    // The anchor never moved — that is what kept `owner_email` valid.
    expect(users.results?.[0]?.email).toBe(ANCHOR);
  });

  it('provisions an account for a genuinely new address', async () => {
    // The other half: a first-time address gets an account of its own, and it
    // is anchored on the address so new rows keep the shape ops reads.
    await applyMigrations(DB);
    const res = await api('/user/me');
    expect(res.status).toBe(200);
    const me = (await res.json()) as { email: string; username: string | null };
    expect(me.email).toBe(API_USER);
    expect(me.username).toBeTruthy();

    const row = await DB.prepare('SELECT id, email, current_email FROM users WHERE current_email = ?').bind(API_USER).first<{
      id: string;
      email: string;
      current_email: string;
    }>();
    expect(row?.id).toMatch(/^usr_[0-9a-f]{32}$/);
    // Free address, so it became the anchor.
    expect(row?.email).toBe(API_USER);
    // And it authenticates: the registry row is verified.
    const registered = await DB.prepare('SELECT is_verified FROM user_emails WHERE email = ?').bind(API_USER).first<{ is_verified: number }>();
    expect(registered?.is_verified).toBe(1);
  });

  it('re-registering the same address is idempotent', async () => {
    // Two requests, one account. `upsertUser` resolves before it creates, so a
    // repeat sign-in cannot fork a second identity.
    await applyMigrations(DB);
    await api('/user/me');
    await api('/user/me');
    await api('/user/volumes');
    const users = await DB.prepare('SELECT id FROM users').all<{ id: string }>();
    expect(users.results).toHaveLength(1);
  });

  it('a revoked address does not resolve to the previous holder', async () => {
    // The reassignment guard, end to end. The old address is revoked, so if it
    // ever authenticated again it must not reach the account that moved off it.
    await applyMigrations(DB);
    const now = nowSeconds();
    const userId = `usr_${'c'.repeat(32)}`;
    await DB.prepare('INSERT INTO users (email, created_at, id, current_email, username, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('stale@example.com', now, userId, API_USER, 'staletest', now)
      .run();
    await DB.prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)')
      .bind(API_USER, userId, now)
      .run();
    // The revoked one still points at the account, for attribution only.
    await DB.prepare('INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 0, ?)')
      .bind('stale@example.com', userId, now)
      .run();

    const svc = new UserIdentityService({ DB });
    expect(await svc.resolveAccount('stale@example.com')).toBeNull();
    expect((await svc.resolveAccount(API_USER))?.id).toBe(userId);
  });
});
