import { describe, expect, it } from 'vitest';
import { UserIdentityService } from '@durable-dav/backend-services/identity';
import { resolveAccount, registerAccount } from '@durable-dav/backend-services/user';
import type { AccountLookupDeps } from '@durable-dav/backend-services/user';
import { UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import { isVolumeOwner } from '@durable-dav/backend-services/dav';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';

/**
 * An in-memory stand-in for the three tables resolution touches: `users`,
 * `user_emails` (the registry), and the anchor uniqueness that `users.email`'s
 * primary key provides.
 */
function fakeIdentityDb(seed: Array<{ id: string; anchor: string; current: string; username?: string | null }> = []) {
  const users = seed.map((u) => ({
    id: u.id,
    email: u.anchor,
    current_email: u.current,
    created_at: 1,
    username: u.username ?? null,
    updated_at: 1,
  }));
  const userEmails = users.map((u) => ({ email: u.email, user_id: u.id, is_verified: 1, created_at: 1 }));
  let anchorSeq = 0;

  const userDAO = {
    getById: async (id: string) => users.find((u) => u.id === id) ?? null,
    getByEmail: async (anchor: string) => users.find((u) => u.email === anchor.toLowerCase()) ?? null,
    getByCurrentEmail: async (email: string) => users.find((u) => u.current_email === email.toLowerCase()) ?? null,
    getByUsernameCi: async (handle: string) => users.find((u) => (u.username ?? '').toLowerCase() === handle.toLowerCase()) ?? null,
    setCurrentEmail: async (id: string, email: string) => {
      const row = users.find((u) => u.id === id);
      if (row) row.current_email = email.toLowerCase();
    },
    // Mirrors `ON CONFLICT(email) DO NOTHING`: a taken anchor is a silent no-op,
    // which is exactly the case `registerAccount` must detect by reading back.
    createUser: async (input: { id?: string | null; anchor: string; loginEmail: string }) => {
      if (users.some((u) => u.email === input.anchor.toLowerCase())) return;
      anchorSeq += 1;
      const id = input.id ?? `usr_gen_${anchorSeq}`;
      users.push({ id, email: input.anchor.toLowerCase(), current_email: input.loginEmail.toLowerCase(), created_at: 1, username: null, updated_at: 1 });
    },
  };

  const userEmailDAO = {
    get: async (email: string) => userEmails.find((e) => e.email === email.toLowerCase()) ?? null,
    resolveVerified: async (email: string) => userEmails.find((e) => e.email === email.toLowerCase() && e.is_verified === 1) ?? null,
    register: async (input: { email: string; userId: string; isVerified: boolean }) => {
      const email = input.email.toLowerCase();
      const existing = userEmails.find((e) => e.email === email);
      if (existing && existing.is_verified === 1) return 'already-claimed' as const;
      if (existing) {
        existing.user_id = input.userId;
        existing.is_verified = input.isVerified ? 1 : 0;
      } else {
        userEmails.push({ email, user_id: input.userId, is_verified: input.isVerified ? 1 : 0, created_at: 1 });
      }
      return 'claimed' as const;
    },
    listByUserId: async (userId: string) => userEmails.filter((e) => e.user_id === userId),
    revokeAllVerified: async (userId: string, exceptEmail: string) => {
      for (const e of userEmails) {
        if (e.user_id === userId && e.email !== exceptEmail.toLowerCase()) e.is_verified = 0;
      }
    },
  };

  // Cast at the boundary: these fakes implement the handful of methods
  // `accountLookup` actually calls, not the full DAO surface, and the structural
  // mismatch on `BaseDAO`'s `database` field is not what these tests are about.
  return { users, userEmails, deps: { userDAO: async () => userDAO, userEmailDAO: async () => userEmailDAO } as unknown as AccountLookupDeps };
}

/**
 * `UserEmailDAO` against a recording D1.
 *
 * The registry is the security-critical write path — it is what stops one
 * account from claiming another's address — and the rest of this file exercises
 * it only through fakes. These assert the actual statements.
 */
describe('UserEmailDAO statements', () => {
  function recordingDb(): { db: D1Database; queries: string[]; bindings: unknown[] } {
    const queries: string[] = [];
    const bindings: unknown[] = [];
    const db = {
      prepare: (sql: string) => {
        queries.push(sql);
        return {
          bind: (...values: unknown[]) => {
            bindings.push(...values);
            return {
              first: () => Promise.resolve(null),
              all: () => Promise.resolve({ results: [] }),
              run: () => Promise.resolve({ success: true, meta: {} }),
            };
          },
        };
      },
    };
    return { db: db as unknown as D1Database, queries, bindings };
  }

  it('register claims a free address as verified', async () => {
    // `register` reads the address first (to decide whether it is already
    // claimed), so the INSERT is the *second* statement, not the first.
    const { db, queries, bindings } = recordingDb();
    expect(await new UserEmailDAO(db).register({ email: 'New@X.co', userId: 'usr_a', isVerified: true, now: 7 })).toBe('claimed');
    expect(queries[0]).toMatch(/SELECT \* FROM user_emails/u);
    expect(queries[1]).toMatch(/INSERT INTO user_emails/u);
    // Lowercased parameter, so the primary key seek stays usable and one address
    // cannot be registered under two casings. Bindings are flattened across both
    // statements: the SELECT takes the address, the INSERT the rest.
    expect(bindings).toEqual(['new@x.co', 'new@x.co', 'usr_a', 1, 7]);
  });

  it('register un-verifies when asked', async () => {
    const { db, bindings } = recordingDb();
    await new UserEmailDAO(db).register({ email: 'a@x.co', userId: 'usr_a', isVerified: false, now: 7 });
    expect(bindings).toEqual(['a@x.co', 'a@x.co', 'usr_a', 0, 7]);
  });

  it('register refuses to re-point a verified address', async () => {
    // The read-before-write is what makes this safe; without it the upsert would
    // hand a live login to a different account. `INSERT` statements are recorded
    // so a write can be proven not to have happened.
    const statements: string[] = [];
    const occupied = {
      prepare: (sql: string) => {
        if (sql.startsWith('INSERT')) statements.push(sql);
        return {
          bind: () => ({
            first: () => Promise.resolve({ email: 'a@x.co', user_id: 'usr_other', is_verified: 1, created_at: 1 }),
            run: () => Promise.resolve({ success: true, meta: {} }),
          }),
        };
      },
    };
    expect(await new UserEmailDAO(occupied as unknown as D1Database).register({ email: 'a@x.co', userId: 'usr_a', isVerified: true, now: 7 })).toBe(
      'already-claimed',
    );
    expect(statements).toEqual([]);
  });

  it('register re-points a revoked address, releasing it', async () => {
    const statements: string[] = [];
    const revoked = {
      prepare: (sql: string) => {
        if (sql.startsWith('INSERT')) statements.push(sql);
        return {
          bind: () => ({
            first: () => Promise.resolve({ email: 'a@x.co', user_id: 'usr_old', is_verified: 0, created_at: 1 }),
            run: () => Promise.resolve({ success: true, meta: {} }),
          }),
        };
      },
    };
    expect(await new UserEmailDAO(revoked as unknown as D1Database).register({ email: 'a@x.co', userId: 'usr_new', isVerified: true, now: 7 })).toBe(
      'claimed',
    );
    // The upsert is what hands the address to its new holder.
    expect(statements[0]).toMatch(/ON CONFLICT\(email\) DO UPDATE SET user_id/u);
  });

  it('resolveVerified filters on the verified flag', async () => {
    const { db, queries, bindings } = recordingDb();
    await new UserEmailDAO(db).resolveVerified('A@X.co');
    expect(queries[0]).toMatch(/WHERE email = \? AND is_verified = 1/u);
    expect(bindings[0]).toBe('a@x.co');
  });

  it('revokeAllVerified spares the address being moved to', async () => {
    const { db, queries, bindings } = recordingDb();
    await new UserEmailDAO(db).revokeAllVerified('usr_a', 'New@X.co');
    expect(queries[0]).toMatch(/is_verified = 0 WHERE user_id = \? AND email != \?/u);
    expect(bindings).toEqual(['usr_a', 'new@x.co']);
  });

  it('revoke clears the flag for one address', async () => {
    const { db, queries, bindings } = recordingDb();
    await new UserEmailDAO(db).revoke('A@X.co');
    expect(queries[0]).toMatch(/UPDATE user_emails SET is_verified = 0 WHERE email = \?/u);
    expect(bindings[0]).toBe('a@x.co');
  });

  it('listByUserId returns verified rows first', async () => {
    const { db, queries } = recordingDb();
    await new UserEmailDAO(db).listByUserId('usr_a');
    expect(queries[0]).toMatch(/ORDER BY is_verified DESC, created_at ASC/u);
  });
});

describe('address -> account resolution', () => {
  it('resolves through the registry, not the anchor', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'old@x.co', current: 'new@x.co', username: 'alice' }]);
    // A second verified address: the account moved here.
    db.userEmails.push({ email: 'new@x.co', user_id: 'usr_a', is_verified: 1, created_at: 2 });
    db.userEmails[0]!.is_verified = 0;

    const account = await resolveAccount(db.deps, 'NEW@x.co');
    expect(account).toEqual({ id: 'usr_a', email: 'new@x.co', anchorEmail: 'old@x.co', username: 'alice' });
  });

  it('a revoked address does not resolve, even though its account exists', async () => {
    // The reassignment guard: after moving off an address, the old one must stop
    // authenticating, or a later holder inherits the previous owner's buckets.
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'old@x.co', current: 'new@x.co' }]);
    db.userEmails[0]!.is_verified = 0;
    expect(await resolveAccount(db.deps, 'old@x.co')).toBeNull();
  });

  it('an unknown address resolves to null rather than throwing', async () => {
    const db = fakeIdentityDb();
    expect(await resolveAccount(db.deps, 'nobody@x.co')).toBeNull();
  });

  it('an empty or malformed address resolves to null', async () => {
    const db = fakeIdentityDb();
    expect(await resolveAccount(db.deps, '')).toBeNull();
    expect(await resolveAccount(db.deps, 'not-an-email')).toBeNull();
  });
});

describe('registerAccount', () => {
  it('anchors on the address when it is free', async () => {
    const db = fakeIdentityDb();
    const account = await registerAccount(db.deps, 'alice@x.co', 'alice@x.co', 1);
    expect(account?.id).toBeTruthy();
    // Anchored on the real address, so new rows keep the shape ops reads.
    expect(db.users[0]?.email).toBe('alice@x.co');
  });

  it('returns null when the anchor is already held, so the caller can retry', async () => {
    // `old@x.co` is the previous holder's anchor; their registry row is revoked.
    const db = fakeIdentityDb([{ id: 'usr_old', anchor: 'shared@x.co', current: 'moved@x.co' }]);
    db.userEmails[0]!.is_verified = 0;
    expect(await registerAccount(db.deps, 'shared@x.co', 'shared@x.co', 2)).toBeNull();
  });

  it('the retry under an opaque anchor yields a genuinely new account', async () => {
    // Regression guard for a real defect: if the second attempt trusted its own
    // generated id, the registry row would point at a nonexistent account and
    // the address would never resolve again — permanently stranding it.
    const db = fakeIdentityDb([{ id: 'usr_old', anchor: 'shared@x.co', current: 'moved@x.co' }]);
    db.userEmails[0]!.is_verified = 0;

    const retry = await registerAccount(db.deps, 'shared@x.co', UserDAO.newAnchor(), 2);
    expect(retry).not.toBeNull();
    expect(retry?.id).not.toBe('usr_old');
    // And it is a *new* account, so the previous holder keeps their own.
    expect(retry?.id).toBeTruthy();
    expect(db.users.filter((u) => u.id === 'usr_old')).toHaveLength(1);
  });

  it('never lets a taken verified address be re-pointed', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'alice@x.co', current: 'alice@x.co' }]);
    const dao = (await db.deps.userEmailDAO()) as unknown as UserEmailDAO;
    expect(await dao.register({ email: 'alice@x.co', userId: 'usr_imposter', isVerified: true, now: 1 })).toBe('already-claimed');
    // And the address still points at its real owner.
    expect((await dao.get('alice@x.co'))?.user_id).toBe('usr_a');
  });
});

describe('UserIdentityService', () => {
  it('memoizes the address resolution for the scope', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co' }]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    let calls = 0;
    const counting = { ...db.deps, userEmailDAO: async () => { calls += 1; return db.deps.userEmailDAO(); } };
    const memoized = new UserIdentityService({ DB: {} as never }, counting);
    expect((await memoized.resolveAccount('a@x.co'))?.id).toBe('usr_a');
    expect((await memoized.resolveAccount('a@x.co'))?.id).toBe('usr_a');
    expect(calls).toBe(1);
    expect(await svc.resolveUserId('a@x.co')).toBe('usr_a');
  });

  it('setPrimaryEmail moves the login address and revokes the old one', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'old@x.co', current: 'old@x.co', username: 'alice' }]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);

    const updated = await svc.setPrimaryEmail('usr_a', 'New@x.co', 100);
    expect(updated.email).toBe('new@x.co');
    // The anchor never moves — it is the `dav_volumes.owner_email` FK target.
    expect(updated.anchorEmail).toBe('old@x.co');
    expect(db.users[0]?.current_email).toBe('new@x.co');
    // Old address retained but revoked, so pre-change rows stay attributable.
    const old = db.userEmails.find((e) => e.email === 'old@x.co');
    expect(old?.is_verified).toBe(0);
    expect(old?.user_id).toBe('usr_a');
  });

  it('setPrimaryEmail refuses an address that is a live login for another account', async () => {
    const db = fakeIdentityDb([
      { id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co' },
      { id: 'usr_b', anchor: 'b@x.co', current: 'b@x.co' },
    ]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    // Without this check, anyone could claim an address and inherit its buckets:
    // Access is the only authenticator, so there is no proof of control here.
    await expect(svc.setPrimaryEmail('usr_a', 'b@x.co', 100)).rejects.toThrow(/already in use/);
  });

  it('setPrimaryEmail is a no-op when the address is already current', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co' }]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    await expect(svc.setPrimaryEmail('usr_a', 'a@x.co', 100)).resolves.toMatchObject({ id: 'usr_a', email: 'a@x.co' });
  });

  it('setPrimaryEmail rejects a malformed address and an unknown account', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co' }]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    await expect(svc.setPrimaryEmail('usr_a', 'nope', 100)).rejects.toThrow(/Invalid email/);
    await expect(svc.setPrimaryEmail('usr_ghost', 'c@x.co', 100)).rejects.toThrow(/User not found/);
  });

  it('linkVerifiedEmail attaches an address without moving the login one', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co' }]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    await svc.linkVerifiedEmail('usr_a', 'alias@x.co', 100);
    expect(db.users[0]?.current_email).toBe('a@x.co');
    // The alias authenticates, so it resolves to the same account.
    expect((await svc.resolveAccount('alias@x.co'))?.id).toBe('usr_a');
  });

  it('linkVerifiedEmail refuses an address already claimed', async () => {
    const db = fakeIdentityDb([
      { id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co' },
      { id: 'usr_b', anchor: 'b@x.co', current: 'b@x.co' },
    ]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    await expect(svc.linkVerifiedEmail('usr_a', 'b@x.co', 100)).rejects.toThrow(/already in use/);
  });

  it('listAddresses reports verified first', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'a@x.co', current: 'b@x.co' }]);
    db.userEmails.push({ email: 'b@x.co', user_id: 'usr_a', is_verified: 1, created_at: 2 });
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    await expect(svc.listAddresses('usr_a')).resolves.toEqual([
      { email: 'a@x.co', isVerified: true },
      { email: 'b@x.co', isVerified: true },
    ]);
  });

  it('resolveUserById is the inverse direction, reporting the current address', async () => {
    const db = fakeIdentityDb([{ id: 'usr_a', anchor: 'old@x.co', current: 'new@x.co' }]);
    const svc = new UserIdentityService({ DB: {} as never }, db.deps);
    await expect(svc.resolveUserById('usr_a')).resolves.toEqual({
      id: 'usr_a',
      email: 'new@x.co',
      anchorEmail: 'old@x.co',
      username: null,
    });
    expect(await svc.resolveUserById('usr_ghost')).toBeNull();
  });
});

describe('ownership after an address change', () => {
  const volume = {
    id: 'v1',
    owner_email: 'old@x.co',
    owner_user_id: 'usr_a',
    owner: 'alice',
    name: 'photos',
    is_private: 1,
  } as DavVolumeRow;

  it('the same account keeps access with its new address', () => {
    expect(isVolumeOwner({ userId: 'usr_a', email: 'new@x.co' }, volume)).toBe(true);
  });

  it('a different account with the old address is refused', () => {
    expect(isVolumeOwner({ userId: 'usr_b', email: 'old@x.co' }, volume)).toBe(false);
  });

  it('a pre-0004 row still matches on the anchor, address only', () => {
    // Documented limitation of the pre-backfill shape: with no `owner_user_id`
    // the anchor is the only signal, so anyone authenticating as that address is
    // the owner. That is safe *only* because the anchor is immutable and cannot
    // be re-registered — and it is why the backfill matters. Once the column is
    // present, the address is no longer consulted at all (asserted above).
    const legacy = { ...volume, owner_user_id: null } as DavVolumeRow;
    expect(isVolumeOwner({ userId: null, email: 'old@x.co' }, legacy)).toBe(true);
    expect(isVolumeOwner({ userId: 'usr_a', email: 'other@x.co' }, legacy)).toBe(false);
  });

  it('an anonymous viewer is never the owner', () => {
    expect(isVolumeOwner(null, volume)).toBe(false);
  });
});
