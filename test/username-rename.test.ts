import { describe, expect, it } from 'vitest';
import { DavVolumeDAO, UserDAO } from '@durable-dav/backend-data/dao';
import { UserService } from '@durable-dav/backend-services/user';

type UserRowFixture = {
  id: string;
  email: string;
  current_email: string;
  created_at: number;
  username: string | null;
  updated_at: number | null;
};

type NamespaceRowFixture = {
  username_ci: string;
  kind: string;
  user_email: string | null;
  user_id: string | null;
  created_at: number;
};

type EmailRowFixture = { email: string; user_id: string; is_verified: number; created_at: number };

/**
 * A fake D1 holding the post-0004 shape: `users` carries the stable `id` and the
 * mutable `current_email` alongside the frozen anchor `email`, and `user_emails`
 * is the address registry that resolution goes through.
 */
function fakeDb() {
  return {
    users: [] as UserRowFixture[],
    namespaces: [] as NamespaceRowFixture[],
    userEmails: [] as EmailRowFixture[],
    volumes: [] as Array<{ id: string; owner_email: string; owner_user_id: string | null; owner: string; name: string; owner_ci: string }>,
  };
}

type Db = ReturnType<typeof fakeDb>;

function makeD1(db: Db) {
  return {
    prepare: (query: string) => ({
      bind: (...bindings: unknown[]) => ({
        first: async () => {
          // The DAOs lowercase the *parameter* instead of wrapping the column in
          // `lower()`, so the index on each column stays usable.
          if (query.includes('FROM users WHERE id = ?')) {
            return (db.users.find((u) => u.id === String(bindings[0])) ?? null) as never;
          }
          if (query.includes('FROM users WHERE current_email = ?')) {
            return (db.users.find((u) => u.current_email === String(bindings[0]).toLowerCase()) ?? null) as never;
          }
          if (query.includes('FROM users WHERE email = ?')) {
            return (db.users.find((u) => u.email === String(bindings[0]).toLowerCase()) ?? null) as never;
          }
          if (query.includes('FROM users WHERE username = ?')) {
            return (db.users.find((u) => (u.username ?? '') === String(bindings[0]).toLowerCase()) ?? null) as never;
          }
          if (query.includes('FROM user_emails WHERE email = ?')) {
            return (db.userEmails.find((e) => e.email === String(bindings[0]).toLowerCase()) ?? null) as never;
          }
          return query.includes('FROM namespaces WHERE username_ci')
            ? ((db.namespaces.find((n) => n.username_ci === String(bindings[0])) ?? null) as never)
            : (null as never);
        },
        all: async () => ({ results: [] }) as never,
        run: async () => {
          if (query.startsWith('INSERT INTO namespaces ')) {
            const [usernameCi, kind, userEmail, userId, createdAt] = bindings as [string, string, string | null, string | null, number];
            if (db.namespaces.some((n) => n.username_ci === usernameCi)) throw new Error('UNIQUE constraint failed: namespaces.username_ci');
            db.namespaces.push({ username_ci: usernameCi, kind, user_email: userEmail, user_id: userId, created_at: createdAt });
            return { success: true } as never;
          }
          if (query.startsWith('INSERT OR IGNORE INTO namespaces')) {
            const [usernameCi, kind, userEmail, userId, createdAt] = bindings as [string, string, string | null, string | null, number];
            if (db.namespaces.every((n) => n.username_ci !== usernameCi)) {
              db.namespaces.push({ username_ci: usernameCi, kind, user_email: userEmail, user_id: userId, created_at: createdAt });
            }
            return { success: true } as never;
          }
          // `setUsername`/`ensureUsername` bind (value, now, idOrEmail, idOrEmail)
          // — the predicate matches either the account key or the anchor.
          if (query.startsWith('UPDATE users SET username = ?')) {
            const [username, now, idOrEmail] = bindings as [string, number, string];
            const row = db.users.find((u) => u.id === idOrEmail || u.email === idOrEmail.toLowerCase());
            if (row) {
              row.username = username;
              row.updated_at = now;
            }
            return { success: true } as never;
          }
          if (query.startsWith('UPDATE users SET username = COALESCE')) {
            const [username, now, idOrEmail] = bindings as [string, number, string];
            const row = db.users.find((u) => u.id === idOrEmail || u.email === idOrEmail.toLowerCase());
            if (row && !row.username) {
              row.username = username;
              row.updated_at = now;
            }
            return { success: true } as never;
          }
          if (query.startsWith('UPDATE dav_volumes SET owner = ?')) {
            const [newOwner, newOwnerCi, now, oldOwnerCi] = bindings as [string, string, number, string];
            for (const volume of db.volumes) {
              if (volume.owner_ci !== oldOwnerCi.toLowerCase()) continue;
              volume.owner = newOwner;
              volume.owner_ci = newOwnerCi.toLowerCase();
              void now;
            }
            return { success: true } as never;
          }
          return { success: true } as never;
        },
      }),
    }),
  };
}

function seedUser(db: Db, id: string, email: string, username: string | null): void {
  db.users.push({ id, email, current_email: email, created_at: 1, username, updated_at: 1 });
  db.userEmails.push({ email, user_id: id, is_verified: 1, created_at: 1 });
  if (username) db.namespaces.push({ username_ci: username.toLowerCase(), kind: 'user', user_email: email, user_id: id, created_at: 1 });
}

function seedAlice(db: Db): void {
  seedUser(db, 'usr_alice', 'alice@example.com', 'alice');
}

describe('DavVolumeDAO.renameOwner', () => {
  it('updates owner and owner_ci for the old namespace only', async () => {
    const seen: Array<{ sql: string; bindings: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => {
          seen.push({ sql, bindings });
          return { run: async () => ({ success: true }) };
        },
      }),
    };
    const dao = new DavVolumeDAO(db as never);
    await dao.renameOwner('Alice', 'Alice2', 42);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain('UPDATE dav_volumes SET owner = ?');
    expect(seen[0]?.bindings).toEqual(['Alice2', 'alice2', 42, 'alice']);
  });
});

describe('UserService rename with volume cascade', () => {
  it('renames, reserves the old name for others, cascades volumes, and allows self reclaim', async () => {
    const db = fakeDb();
    seedAlice(db);
    db.volumes.push({
      id: 'vol-1',
      owner_email: 'alice@example.com',
      owner_user_id: 'usr_alice',
      owner: 'alice',
      name: 'photos',
      owner_ci: 'alice',
    });
    const svc = new UserService({ DB: makeD1(db) as never });

    const renamed = await svc.renameUsername('alice@example.com', 'Alice2');
    // Normalised to lowercase, not stored as typed. `users.username` is BINARY
    // collated and every read lowercases its parameter, so a stored `Alice2` is
    // a different value from `alice2` and the handle becomes permanently
    // unfindable: `GET /users/alice2` 404s, and re-submitting the same name hits
    // the case-insensitive equality short-circuit and reports success while
    // changing nothing — no way back through the API.
    expect(renamed).toEqual({ id: 'usr_alice', email: 'alice@example.com', username: 'alice2' });
    // The account id and the frozen anchor are untouched by a rename: only the
    // handle moves.
    expect(db.users[0]?.id).toBe('usr_alice');
    expect(db.users[0]?.email).toBe('alice@example.com');
    // The stored column is normalised, and the handle still round-trips through
    // the CI lookup — the property that was broken.
    expect(db.users[0]?.username).toBe('alice2');
    expect(await new UserDAO(makeD1(db) as never).getByUsernameCi('ALICE2')).not.toBeNull();
    expect(await new UserDAO(makeD1(db) as never).getByUsernameCi('alice2')).not.toBeNull();
    expect(db.namespaces.some((n) => n.username_ci === 'alice')).toBe(true);
    expect(db.volumes[0]?.owner).toBe('alice2');
    expect(db.volumes[0]?.owner_ci).toBe('alice2');

    seedUser(db, 'usr_bob', 'bob@x.co', 'bob');
    const bobSvc = new UserService({ DB: makeD1(db) as never });
    await expect(bobSvc.renameUsername('bob@x.co', 'alice')).rejects.toThrow('already taken');

    await expect(svc.renameUsername('alice@example.com', 'alice')).resolves.toEqual({
      id: 'usr_alice',
      email: 'alice@example.com',
      username: 'alice',
    });
    await expect(svc.renameUsername('alice@example.com', 'ALICE')).resolves.toMatchObject({ username: 'alice' });
  });

  it('resolves the account from the current address, not the anchor', async () => {
    // After an address change the anchor lookup fails and the registry lookup
    // succeeds — the property that makes an address change non-fatal.
    const db = fakeDb();
    seedUser(db, 'usr_alice', 'old@x.co', 'alice');
    db.userEmails.push({ email: 'new@x.co', user_id: 'usr_alice', is_verified: 1, created_at: 2 });
    db.users[0]!.current_email = 'new@x.co';

    const svc = new UserService({ DB: makeD1(db) as never });
    await expect(svc.renameUsername('new@x.co', 'alice2')).resolves.toEqual({
      id: 'usr_alice',
      email: 'new@x.co',
      username: 'alice2',
    });
  });

  it('reclaims a self-owned namespace when the claim races', async () => {
    let released = 0;
    const svc = new UserService({ DB: {} } as never, {
      userDAO: () =>
        Promise.resolve({
          getById: async () => null,
          getByCurrentEmail: async () => ({ id: 'usr_alice', email: 'alice@example.com', current_email: 'alice@example.com', username: 'alice' }),
          getByUsernameCi: async () => null,
          setUsername: async () => undefined,
        }) as never,
      userEmailDAO: () => Promise.resolve({ get: async () => null } as never),
      namespaceDAO: () =>
        Promise.resolve({
          isTaken: async () => false,
          claim: async () => {
            throw new Error('UNIQUE constraint failed: namespaces.username_ci');
          },
          // Owned by self, so this is a rename-back rather than a conflict.
          get: async () => ({
            username_ci: 'alice2',
            kind: 'user',
            user_email: 'alice@example.com',
            user_id: 'usr_alice',
            created_at: 1,
          }),
          release: async () => {
            released += 1;
          },
        }) as never,
      volumeDAO: () => Promise.resolve({ renameOwner: async () => undefined }) as never,
    });
    await expect(svc.renameUsername('alice@example.com', 'alice2')).resolves.toEqual({
      id: 'usr_alice',
      email: 'alice@example.com',
      username: 'alice2',
    });
    expect(released).toBe(0);
  });

  it('rolls back a fresh namespace claim when setUsername fails', async () => {
    let released: string | null = null;
    const svc = new UserService({ DB: {} } as never, {
      userDAO: () =>
        Promise.resolve({
          getById: async () => null,
          getByCurrentEmail: async () => ({ id: 'usr_alice', email: 'alice@example.com', current_email: 'alice@example.com', username: 'alice' }),
          getByUsernameCi: async () => null,
          setUsername: async () => {
            throw new Error('D1 busy');
          },
        }) as never,
      userEmailDAO: () => Promise.resolve({ get: async () => null } as never),
      namespaceDAO: () =>
        Promise.resolve({
          isTaken: async () => false,
          claim: async () => undefined,
          get: async () => null,
          release: async (ci: string) => {
            released = ci;
          },
        }) as never,
      volumeDAO: () => Promise.resolve({ renameOwner: async () => undefined }) as never,
    });
    await expect(svc.renameUsername('alice@example.com', 'alice2')).rejects.toThrow('D1 busy');
    expect(released).toBe('alice2');
  });

  it('rejects taken, invalid, reserved, and missing renames', async () => {
    const db = fakeDb();
    seedAlice(db);
    seedUser(db, 'usr_bob', 'bob@x.co', 'taken2');
    const svc = new UserService({ DB: makeD1(db) as never });
    await expect(svc.renameUsername('alice@example.com', 'taken2')).rejects.toThrow('already taken');
    await expect(svc.renameUsername('alice@example.com', 'bad name!')).rejects.toThrow('Invalid username');
    await expect(svc.renameUsername('alice@example.com', 'admin')).rejects.toThrow('reserved');
    await expect(svc.renameUsername('ghost@x.co', 'fresh')).rejects.toThrow('User not found');
  });

  it('falls back to legacy usernames when the namespace table is missing', async () => {
    const db = fakeDb();
    seedUser(db, 'usr_legacy', 'legacy@x.co', 'legacy');
    const throwing = {
      prepare: (query: string) => {
        if (query.includes('namespaces')) {
          return {
            bind: () => ({
              first: () => Promise.reject(new Error('no such table: namespaces')),
              all: () => Promise.reject(new Error('no such table: namespaces')),
              run: () => Promise.reject(new Error('no such table: namespaces')),
            }),
          };
        }
        return (makeD1(db) as unknown as Record<string, (q: string) => unknown>).prepare(query) as never;
      },
    };
    const svc = new UserService({ DB: throwing as never });
    await expect(svc.renameUsername('legacy@x.co', 'legacy2')).resolves.toEqual({
      id: 'usr_legacy',
      email: 'legacy@x.co',
      username: 'legacy2',
    });
  });
});
