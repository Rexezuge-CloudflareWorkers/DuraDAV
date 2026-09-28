import { describe, expect, it } from 'vitest';
import { VolumeService } from '../packages/backend-services/src/dav/VolumeService';
import { VolumeCredentialService } from '../packages/backend-services/src/dav/VolumeCredentialService';
import { DavLockGuard } from '../apps/background/src/dav/DavLockGuard';

/**
 * Minimal in-memory `dav_locks` double.
 *
 * Understands the two query shapes `DavLockGuard` issues by counting the
 * placeholders in the `path IN (…)` clause, rather than guessing from the
 * position of the first binding — positional guessing silently returned `[]`
 * when the query shape changed, which reads as "not locked" and turns a
 * refactor into a false green.
 */
type LockRow = { token: string; scope: string; depth: string; expires_at: number };

type LockRowMap = Record<string, LockRow[]>;

function lockSql(rowsByPath: LockRowMap) {
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const inMatch = /path IN \(([^)]*)\)/.exec(query);
      if (!inMatch) return { toArray: () => [] };
      const pathCount = (inMatch[1]?.match(/\?/g) ?? []).length;
      const paths = bindings.slice(0, pathCount).filter((b): b is string => typeof b === 'string');
      const now = bindings[pathCount] as number;
      const rows: Array<LockRow & { path: string }> = paths
        .flatMap((p) => (rowsByPath[p] ?? []).map((row) => ({ ...row, path: p })))
        .filter((row) => Number(row.expires_at ?? 0) > now);
      return { toArray: () => rows };
    },
  };
}

describe('VolumeService quota hardening', () => {
  // The quota counts by account key (migration 0004), not by address: a user who
  // changed address still owns the same buckets, and an email-keyed count would
  // read as zero and let them exceed the limit.
  const identity = () => Promise.resolve({ resolveAccount: async () => ({ id: 'usr_a', email: 'a@x.co', anchorEmail: 'a@x.co', username: 'alice' }) } as never);

  it('prefers COUNT(*) over listing rows', async () => {
    let listed = false;
    const svc = new VolumeService(
      { DB: {} as never, MAX_VOLUMES_PER_USER: '1' },
      {
        volumeDAO: () =>
          Promise.resolve({
            countByOwnerUserId: async () => 1,
            listByOwnerUserId: async () => {
              listed = true;
              return [];
            },
            getByOwnerName: async () => null,
          } as never),
        identity,
        credentialDAO: () => Promise.resolve({} as never),
      },
    );
    await expect(svc.createVolume({ owner: 'alice', name: 'b1', creatorEmail: 'a@x.co' })).rejects.toThrow(/Maximum 1 volumes/);
    expect(listed).toBe(false);
  });

  it('falls back to list length when COUNT is unavailable (fake-DB compat)', async () => {
    const svc = new VolumeService(
      { DB: {} as never, MAX_VOLUMES_PER_USER: '1' },
      {
        volumeDAO: () =>
          Promise.resolve({
            countByOwnerUserId: async () => {
              throw new Error('no such function: count');
            },
            listByOwnerUserId: async () => [{ id: 'v1' }],
            getByOwnerName: async () => null,
          } as never),
        identity,
        credentialDAO: () => Promise.resolve({} as never),
      },
    );
    await expect(svc.createVolume({ owner: 'alice', name: 'b1', creatorEmail: 'a@x.co' })).rejects.toThrow(/Maximum 1 volumes/);
  });

  it('fails closed when the caller has no resolvable account', async () => {
    // The ownership check is skipped entirely when the account cannot be
    // resolved, so this must throw rather than return null and let `createVolume`
    // proceed. Regression: a D1 blip used to let an authenticated caller create
    // buckets in any user's namespace.
    const svc = new VolumeService(
      { DB: {} as never },
      {
        volumeDAO: () => Promise.resolve({ getByOwnerName: async () => null } as never),
        identity: () => Promise.resolve({ resolveAccount: async () => null } as never),
        credentialDAO: () => Promise.resolve({} as never),
      },
    );
    await expect(svc.createVolume({ owner: 'mallory', name: 'b1', creatorEmail: 'a@x.co' })).rejects.toThrow(/No account is provisioned/);
  });

  it('fails closed when the account exists but has no handle', async () => {
    const svc = new VolumeService(
      { DB: {} as never },
      {
        volumeDAO: () => Promise.resolve({ getByOwnerName: async () => null } as never),
        identity: () => Promise.resolve({ resolveAccount: async () => ({ id: 'usr_a', email: 'a@x.co', anchorEmail: 'a@x.co', username: null }) } as never),
        credentialDAO: () => Promise.resolve({} as never),
      },
    );
    await expect(svc.createVolume({ owner: 'alice', name: 'b1', creatorEmail: 'a@x.co' })).rejects.toThrow(/No username is provisioned/);
  });
});

describe('VolumeCredentialService config injection hardening', () => {
  it('honors injected AppConfiguration over env strings', async () => {
    const svc = new VolumeCredentialService(
      { DB: {} as never, MAX_CREDENTIALS_PER_VOLUME: '100' },
      {
        credentialDAO: () => Promise.resolve({ countByVolume: async () => 5 } as never),
        config: { getMaxCredentialsPerVolume: () => 5 } as never,
      },
    );
    await expect(svc.createCredential('v1', 'photos', 'laptop')).rejects.toThrow(/Maximum 5 credentials/);
  });
});

describe('DavLockGuard hardening', () => {
  it('returns 423 when a lock token is missing and null when supplied', () => {
    const sql = lockSql({
      'a/b': [{ token: 'opaquelocktoken:1', scope: 'exclusive', depth: '0', expires_at: Date.now() + 60_000 }],
    });
    const guard = new DavLockGuard(sql as never);
    const locked = guard.assertLock(new Request('https://x/'), 'a/b');
    expect(locked?.status).toBe(423);
    const unlocked = guard.assertLock(new Request('https://x/', { headers: { If: '(<opaquelocktoken:1>)' } }), 'a/b');
    expect(unlocked).toBeNull();
  });

  it('treats Depth:infinity ancestor locks as covering descendants', () => {
    const sql = lockSql({
      a: [{ token: 'opaquelocktoken:root', scope: 'exclusive', depth: 'infinity', expires_at: Date.now() + 60_000 }],
    });
    const guard = new DavLockGuard(sql as never);
    expect(guard.assertLock(new Request('https://x/'), 'a/b/c')?.status).toBe(423);
  });
});
