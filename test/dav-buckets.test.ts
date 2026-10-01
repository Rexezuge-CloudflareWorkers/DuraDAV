import { describe, expect, it } from 'vitest';
import { DavPermissionService, VolumeService, VolumeCredentialService, checkVolumeQuota } from '@durable-dav/backend-services/dav';
import { DavCredentialUtil } from '@durable-dav/shared/utils';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';

function fakeVolumeDb(opts: { ownedCount?: number; username?: string | null; existing?: unknown } = {}) {
  const calls = { credentialsDeleted: 0 };
  const volumeDAO = {
    getByOwnerName: async () => (opts.existing as never) ?? null,
    getById: async () => (opts.existing as never) ?? null,
    countByOwnerUserId: async () => opts.ownedCount ?? 0,
    listByOwnerUserId: async () => Array.from({ length: opts.ownedCount ?? 0 }, (_, i) => ({ id: `v${i}` })),
    listByOwnerEmail: async () => Array.from({ length: opts.ownedCount ?? 0 }, (_, i) => ({ id: `v${i}` })),
    create: async () => undefined,
    update: async () => undefined,
    deleteById: async () => undefined,
  };
  // The caller's account, as `UserIdentityService` would resolve it: a stable
  // id plus the handle the bucket URL namespace is keyed on.
  const identity = () =>
    Promise.resolve({
      resolveAccount: async () =>
        opts.username === null
          ? null
          : {
              id: 'usr_alice',
              email: 'a@x.co',
              anchorEmail: 'a@x.co',
              username: opts.username ?? 'alice',
            },
    } as never);
  return {
    calls,
    deps: {
      volumeDAO: () => Promise.resolve(volumeDAO as never),
      identity,
      credentialDAO: () =>
        Promise.resolve({
          deleteByVolume: async () => {
            calls.credentialsDeleted += 1;
          },
        } as never),
    },
  };
}

describe('VolumeCreatePolicy quota', () => {
  it('rejects at the cap', () => {
    expect(() => checkVolumeQuota(100, 100)).toThrow(/Maximum 100 volumes/);
    expect(() => checkVolumeQuota(99, 100)).not.toThrow();
  });
});

describe('VolumeService user-only buckets', () => {
  it('enforces per-user quota from MAX_VOLUMES_PER_USER', async () => {
    const { deps } = fakeVolumeDb({ ownedCount: 2, username: 'alice' });
    const svc = new VolumeService({ DB: {} as never, MAX_VOLUMES_PER_USER: '2' }, deps);
    await expect(svc.createVolume({ owner: 'alice', name: 'b1', creatorEmail: 'a@x.co' })).rejects.toThrow(/Maximum 2 volumes/);
  });

  it('rejects owner mismatch (no org volumes)', async () => {
    const { deps } = fakeVolumeDb({ ownedCount: 0, username: 'alice' });
    const svc = new VolumeService({ DB: {} as never }, deps);
    await expect(svc.createVolume({ owner: 'bob', name: 'b1', creatorEmail: 'a@x.co' })).rejects.toThrow(/owner/);
  });

  it('creates private-by-default buckets and cleans credentials on delete', async () => {
    const created = {
      id: 'vol-1',
      owner_email: 'a@x.co',
      owner: 'alice',
      name: 'photos',
      is_private: 1,
    };
    const seen: Array<{ isPrivate: boolean; ownerEmail: string; ownerUserId: string }> = [];
    const { deps, calls } = fakeVolumeDb({ ownedCount: 0, username: 'alice', existing: null });
    const svc = new VolumeService(
      { DB: {} as never },
      {
        ...deps,
        volumeDAO: () =>
          Promise.resolve({
            getByOwnerName: async () => null,
            getById: async () => created as never,
            countByOwnerUserId: async () => 0,
            listByOwnerUserId: async () => [],
            listByOwnerEmail: async () => [],
            create: async (input: { isPrivate: boolean; ownerEmail: string; ownerUserId: string }) => {
              seen.push({ isPrivate: input.isPrivate, ownerEmail: input.ownerEmail, ownerUserId: input.ownerUserId });
            },
            update: async () => undefined,
            deleteById: async () => undefined,
          } as never),
      },
    );
    const row = await svc.createVolume({ owner: 'alice', name: 'photos', creatorEmail: 'A@X.co' });
    expect(row.owner_email).toBe('a@x.co');
    expect(seen[0]?.isPrivate).toBe(true);
    // The row records the account's frozen anchor, not the address the caller
    // happened to sign in with — the two differ once an address changes.
    expect(seen[0]?.ownerEmail).toBe('a@x.co');
    expect(seen[0]?.ownerUserId).toBe('usr_alice');

    const deleter = new VolumeService(
      { DB: {} as never },
      {
        ...deps,
        volumeDAO: () =>
          Promise.resolve({
            getByOwnerName: async () => created as never,
            getById: async () => created as never,
            countByOwnerUserId: async () => 0,
            listByOwnerUserId: async () => [],
            listByOwnerEmail: async () => [],
            create: async () => undefined,
            update: async () => undefined,
            deleteById: async () => undefined,
          } as never),
      },
    );
    await deleter.deleteVolume('alice', 'photos');
    expect(calls.credentialsDeleted).toBe(1);
  });

  it('updates description and visibility owner-only', async () => {
    const stored = {
      id: 'vol-1',
      owner_email: 'a@x.co',
      owner_user_id: 'usr_alice',
      owner: 'alice',
      name: 'photos',
      description: null,
      is_private: 1,
    };
    const { deps } = fakeVolumeDb({ ownedCount: 0, username: 'alice' });
    const svc = new VolumeService(
      { DB: {} as never },
      {
        ...deps,
        volumeDAO: () =>
          Promise.resolve({
            getByOwnerName: async () => stored as never,
            getById: async () => ({ ...stored, description: 'hi', is_private: 0 }) as never,
            countByOwnerUserId: async () => 0,
            listByOwnerUserId: async () => [],
            listByOwnerEmail: async () => [],
            create: async () => undefined,
            update: async () => undefined,
            deleteById: async () => undefined,
          } as never),
      },
    );
    const updated = await svc.updateVolume('alice', 'photos', { userId: 'usr_alice', email: 'a@x.co' }, { description: 'hi', isPrivate: false });
    expect(updated.description).toBe('hi');
    await expect(svc.updateVolume('alice', 'photos', { userId: 'usr_other', email: 'other@x.co' }, { isPrivate: true })).rejects.toThrow(/owner/);
  });

  it('keeps ownership after the owner changes their email address', async () => {
    // The whole point of migration 0004. `owner_email` is the frozen anchor, so
    // a caller who signs in with a *different* address and the *same* account id
    // is still the owner — comparing addresses would have locked them out.
    const stored = {
      id: 'vol-1',
      owner_email: 'old@x.co',
      owner_user_id: 'usr_alice',
      owner: 'alice',
      name: 'photos',
      description: null,
      is_private: 1,
    };
    const svc = new VolumeService(
      { DB: {} as never },
      {
        ...fakeVolumeDb().deps,
        volumeDAO: () =>
          Promise.resolve({
            getByOwnerName: async () => stored as never,
            getById: async () => ({ ...stored, description: 'renamed' }) as never,
            update: async () => undefined,
          } as never),
      },
    );
    const updated = await svc.updateVolume('alice', 'photos', { userId: 'usr_alice', email: 'new@x.co' }, { description: 'renamed' });
    expect(updated.description).toBe('renamed');
  });

  it('does not fall back to the anchor when the row has an owner id', async () => {
    // A pre-0004 row (no `owner_user_id`) may be matched on the address; a
    // 0004 row must not, or an address re-registered by a different account
    // would inherit the bucket.
    const stored = { id: 'v', owner_email: 'shared@x.co', owner_user_id: 'usr_real', owner: 'real', name: 'n', is_private: 1 } as DavVolumeRow;
    const svc = new VolumeService(
      { DB: {} as never },
      { ...fakeVolumeDb().deps, volumeDAO: () => Promise.resolve({ getByOwnerName: async () => stored } as never) },
    );
    await expect(svc.updateVolume('real', 'n', { userId: 'usr_imposter', email: 'shared@x.co' }, { description: 'x' })).rejects.toThrow(/owner/);
  });
});

describe('DavPermissionService owner-only', () => {
  // `getRole` reads only the owner key and `is_private`, so a minimal projection
  // is enough and keeps the fixture readable.
  const volume = { id: 'v1', owner_email: 'owner@x.co', owner_user_id: 'usr_owner', is_private: 1 } as DavVolumeRow;

  it('owner is admin, others hidden on private, public read', () => {
    const perm = new DavPermissionService();
    expect(perm.getRole({ userId: 'usr_owner', email: 'owner@x.co' }, volume)).toBe('admin');
    expect(perm.getRole({ userId: 'usr_friend', email: 'friend@x.co' }, volume)).toBeNull();
    expect(perm.getRole(null, volume)).toBeNull();
    const publicVolume: DavVolumeRow = { ...volume, is_private: 0 };
    expect(perm.getRole(null, publicVolume)).toBe('read');
    expect(perm.getRole({ userId: 'usr_friend', email: 'friend@x.co' }, publicVolume)).toBe('read');
  });

  it('an anonymous viewer never matches an owner key', () => {
    // `getRole(null, ...)` is the public-anon-read path. Before 0004 it took a
    // nullable email, so a caller could pass the owner address; the id makes
    // that unrepresentable.
    const perm = new DavPermissionService();
    expect(perm.getRole(null, volume)).toBeNull();
  });

  it('a viewer with no resolved id is refused on a keyed row', () => {
    // Pre-0004 caller (no `users.id`) against a post-backfill row: refuse, do
    // not fall back to the anchor.
    const perm = new DavPermissionService();
    expect(perm.getRole({ userId: null, email: 'owner@x.co' }, volume)).toBeNull();
  });
});

describe('DavCredentialUtil username pattern', () => {
  it('generates volume-adjective-animal usernames', () => {
    const username = DavCredentialUtil.generateUsername('Photos');
    expect(username.startsWith('photos-')).toBe(true);
    expect(username).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(username).not.toContain(':');
    const parts = username.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });

  it('salts each password hash and still verifies it', async () => {
    // Determinism was the bug: an unsalted digest is rainbow-table reversible,
    // and every user who picked the same password shares a hash. See
    // `test/credential-hashing.test.ts` for the full matrix.
    const a = await DavCredentialUtil.hashPassword('secret');
    const b = await DavCredentialUtil.hashPassword('secret');
    expect(a).not.toBe(b);
    await expect(DavCredentialUtil.verifyPassword('secret', a)).resolves.toMatchObject({ ok: true });
    await expect(DavCredentialUtil.verifyPassword('wrong', a)).resolves.toMatchObject({ ok: false });
  });
});

describe('VolumeCredentialService per-bucket quota', () => {
  it('enforces MAX_CREDENTIALS_PER_VOLUME', async () => {
    const svc = new VolumeCredentialService(
      { DB: {} as never, MAX_CREDENTIALS_PER_VOLUME: '1' },
      {
        credentialDAO: () =>
          Promise.resolve({
            countByVolume: async () => 1,
          } as never),
      },
    );
    await expect(svc.createCredential('v1', 'photos', 'laptop')).rejects.toThrow(/Maximum 1 credentials/);
  });
});
