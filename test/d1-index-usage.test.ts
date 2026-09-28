import { describe, expect, it } from 'vitest';
import { UserDAO } from '@durable-dav/backend-data/dao';
import { DavVolumeDAO } from '@durable-dav/backend-data/dao';

/**
 * Email predicates must be index-usable.
 *
 * `WHERE lower(owner_email) = lower(?)` puts a function call on the column, so
 * SQLite cannot use `idx_dav_volumes_owner_email` and falls back to a full
 * table scan on what is the single hottest query in the product (the
 * dashboard's volume list, plus the quota check behind every create).
 */
describe('D1 predicates do not wrap an indexed column in lower()', () => {
  it('UserDAO looks the user up by email directly', async () => {
    const { db, queries } = recordingDatabase();
    await new UserDAO(db).getByEmail('Alice@Example.com');
    expect(queries[0]).not.toMatch(/lower\(\s*email\s*\)/u);
    expect(queries[0]).toMatch(/WHERE email = \?/u);
  });

  it('UserDAO looks the account up by id directly', async () => {
    // The post-0004 identity read, hit on every authenticated request.
    const { db, queries } = recordingDatabase();
    await new UserDAO(db).getById('usr_ab12');
    expect(queries[0]).toMatch(/WHERE id = \?/u);
  });

  it('UserDAO looks the account up by current_email directly', async () => {
    const { db, queries } = recordingDatabase();
    await new UserDAO(db).getByCurrentEmail('Alice@Example.com');
    expect(queries[0]).not.toMatch(/lower\(\s*current_email\s*\)/u);
    expect(queries[0]).toMatch(/WHERE current_email = \?/u);
  });

  it('UserDAO stamps every identity column on create', async () => {
    // `createUser` writes all three: the anchor (FK target), the account key, and
    // the mutable sign-in address. Omitting any one produces a row that cannot be
    // resolved, since login goes through the key.
    const { db, queries, bindings } = recordingDatabase();
    await new UserDAO(db).createUser({ id: 'usr_ab12', anchor: 'a@x.co', loginEmail: 'a@x.co', now: 1 });
    expect(queries[0]).toMatch(/INSERT INTO users \(email, created_at, id, current_email\)/u);
    expect(bindings).toEqual(['a@x.co', 1, 'usr_ab12', 'a@x.co']);
  });

  it('UserDAO anchors a new account on the login address when it is free', async () => {
    const { db, bindings } = recordingDatabase();
    await new UserDAO(db).upsertUser('Alice@Example.com', 1);
    // Keeping new rows shaped like the pre-0004 ones means ops reads stay intuitive.
    expect(bindings[0]).toBe('alice@example.com');
    // Same address as the sign-in address, so the row resolves immediately.
    expect(bindings[3]).toBe('alice@example.com');
  });

  it('UserDAO newId and newAnchor produce distinct, non-address values', async () => {
    // An anchor must never be a real address: `users.email` is the primary key
    // every legacy `*_email` FK resolves against, so a real address parked there
    // could never be re-registered by a different person.
    const id = UserDAO.newId();
    const anchor = UserDAO.newAnchor();
    expect(id).toMatch(/^usr_[0-9a-f]{32}$/u);
    // `.invalid` is RFC 2606 and can never be delivered to, so it can never
    // authenticate either.
    expect(anchor).toMatch(/^anchor-[0-9a-f]{32}@users\.invalid$/u);
    expect(UserDAO.newId()).not.toBe(id);
    expect(UserDAO.newAnchor()).not.toBe(anchor);
  });

  it('UserDAO setCurrentEmail moves the address and never the anchor', async () => {
    const { db, queries, bindings } = recordingDatabase();
    await new UserDAO(db).setCurrentEmail('usr_ab12', 'New@X.co', 9);
    expect(queries[0]).toMatch(/UPDATE users SET current_email = \?/u);
    // `email` must not appear in the SET list at all: rewriting the anchor would
    // cascade the user's volumes out through the FK.
    expect(queries[0]).not.toMatch(/SET current_email = \?, email/u);
    expect(bindings).toEqual(['new@x.co', 9, 'usr_ab12']);
  });

  it('UserDAO username writes key on the id, with the anchor as fallback', async () => {
    const { db, queries, bindings } = recordingDatabase();
    await new UserDAO(db).setUsername('usr_ab12', 'alice', 9);
    expect(queries[0]).toMatch(/WHERE id = \? OR email = \?/u);
    expect(bindings).toEqual(['alice', 9, 'usr_ab12', 'usr_ab12']);
  });

  it('UserDAO looks the handle up by username directly', async () => {
    const { db, queries } = recordingDatabase();
    await new UserDAO(db).getByUsernameCi('Alice');
    expect(queries[0]).not.toMatch(/lower\(\s*username\s*\)/u);
    expect(queries[0]).toMatch(/WHERE username = \?/u);
  });

  it('DavVolumeDAO lists by owner_user_id directly', async () => {
    // The post-0004 identity read, behind both the dashboard list and the quota
    // check on every create.
    const { db, queries } = recordingDatabase();
    await new DavVolumeDAO(db).listByOwnerUserId('usr_ab12', 100);
    expect(queries[0]).toMatch(/WHERE owner_user_id = \?/u);
  });

  it('DavVolumeDAO counts by owner_user_id directly', async () => {
    const { db, queries } = recordingDatabase();
    await new DavVolumeDAO(db).countByOwnerUserId('usr_ab12');
    expect(queries[0]).toMatch(/WHERE owner_user_id = \?/u);
  });

  it('DavVolumeDAO lists by owner_email directly (pre-0004 fallback)', async () => {
    const { db, queries } = recordingDatabase();
    await new DavVolumeDAO(db).listByOwnerEmail('Alice@Example.com', 100);
    expect(queries[0]).not.toMatch(/lower\(\s*owner_email\s*\)/u);
    expect(queries[0]).toMatch(/WHERE owner_email = \?/u);
  });

  it('DavVolumeDAO counts by owner_email directly (pre-0004 fallback)', async () => {
    const { db, queries } = recordingDatabase();
    await new DavVolumeDAO(db).countByOwnerEmail('Alice@Example.com');
    expect(queries[0]).not.toMatch(/lower\(\s*owner_email\s*\)/u);
    expect(queries[0]).toMatch(/WHERE owner_email = \?/u);
  });

  it('lowercases the binding instead, so case-insensitivity is preserved', async () => {
    // The column is stored lowercased by every writer, so lowercasing the
    // *parameter* gives the same matching semantics while keeping the index.
    const { db, bindings } = recordingDatabase();
    await new DavVolumeDAO(db).listByOwnerEmail('Alice@Example.COM', 100);
    expect(bindings[0]).toBe('alice@example.com');
  });

  it('lowercases the email binding on the user lookup', async () => {
    const { db, bindings } = recordingDatabase();
    await new UserDAO(db).getByEmail('Alice@Example.com');
    expect(bindings[0]).toBe('alice@example.com');
  });

  it('lowercases the binding on the address registry lookup', async () => {
    // `user_emails.email` is the registry primary key, read on every login.
    const { db, queries, bindings } = recordingDatabase();
    const { UserEmailDAO } = await import('@durable-dav/backend-data/dao');
    await new UserEmailDAO(db).get('Alice@Example.com');
    expect(queries[0]).not.toMatch(/lower\(\s*email\s*\)/u);
    expect(queries[0]).toMatch(/WHERE email = \?/u);
    expect(bindings[0]).toBe('alice@example.com');
  });
});

/**
 * The first `describe` block's recorder, shared rather than duplicated: the two
 * suites assert the same predicate style against the same fake, and a second
 * copy would be free to drift.
 */
function recordingDatabase(): { db: D1Database; queries: string[]; bindings: unknown[] } {
  const queries: string[] = [];
  const bindings: unknown[] = [];
  const prepare = (sql: string) => {
    queries.push(sql);
    return {
      bind: (...values: unknown[]) => {
        bindings.push(...values);
        return {
          first: () => Promise.resolve(null),
          run: () => Promise.resolve({ success: true, meta: {} }),
          all: () => Promise.resolve({ results: [] }),
        };
      },
      first: () => Promise.resolve(null),
      run: () => Promise.resolve({ success: true, meta: {} }),
      all: () => Promise.resolve({ results: [] }),
    };
  };
  return { db: { prepare } as unknown as D1Database, queries, bindings };
}

describe('the account key is used for identity, not the address', () => {
  it('a new volume is written with the owner account key', async () => {
    const { db, queries, bindings } = recordingDatabase();
    await new DavVolumeDAO(db).create({
      id: 'v1',
      ownerEmail: 'anchor@x.co',
      ownerUserId: 'usr_ab12',
      owner: 'alice',
      name: 'photos',
      description: null,
      isPrivate: true,
      now: 1,
    });
    // Both are stored: the anchor resolves the FK, the key decides ownership.
    expect(queries[0]).toMatch(/owner_user_id/u);
    expect(bindings).toContain('usr_ab12');
  });

  it('a namespace claim is written with the account key', async () => {
    const { db, queries, bindings } = recordingDatabase();
    const { NamespaceDAO } = await import('@durable-dav/backend-data/dao');
    await new NamespaceDAO(db).claim({
      usernameCi: 'alice',
      kind: 'user',
      userEmail: 'anchor@x.co',
      userId: 'usr_ab12',
      now: 1,
    });
    expect(queries[0]).toMatch(/user_id/u);
    expect(bindings).toContain('usr_ab12');
  });
});

describe('credential lookup is by username, not by hash', () => {
  function credentialDatabase(): { db: D1Database; queries: string[] } {
    const queries: string[] = [];
    const prepare = (sql: string) => {
      queries.push(sql);
      return {
        bind: () => ({ first: () => Promise.resolve(null) }),
        first: () => Promise.resolve(null),
      };
    };
    return { db: { prepare } as unknown as D1Database, queries };
  }

  it('does not search on password_hash', async () => {
    // Passwords are salted, so no hash can be searched on: two users with the
    // same password have different hashes. The auth path loads by the globally
    // unique username and verifies the password in the worker.
    const { db, queries } = credentialDatabase();
    const { DavCredentialDAO } = await import('@durable-dav/backend-data/dao');
    await new DavCredentialDAO(db).getActiveByUsername('alice');
    expect(queries[0]).not.toMatch(/password_hash\s*=/u);
    expect(queries[0]).toMatch(/WHERE username = \? AND expires_at > \?/u);
  });
});
