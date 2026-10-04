import { describe, expect, it } from 'vitest';
import { generatePropfindResponse, getLivePropertyValue } from '@durable-dav/webdav';
import { DavLockGuard } from '../apps/background/src/dav/DavLockGuard';
import { VolumeService } from '../packages/backend-services/src/dav/VolumeService';
import { deleteNodeCascade, renameNodeCascade } from '../packages/dav-store/src/meta';

describe('live property lookup rejects prototype-chain keys', () => {
  // Regression: `toLiveProperties(node)[property.localName as keyof DavLiveProperties]`
  // walked the prototype chain, so a client-supplied `<D:constructor/>` in a
  // PROPFIND returned a *function* which `escapeXml` then called
  // `.replaceAll` on — an unauthenticated 500 on any bucket.
  const NODE_PROPS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];

  for (const localName of NODE_PROPS) {
    it(`treats <D:${localName}/> as absent instead of crashing`, () => {
      const property = { namespaceURI: 'DAV:', prefix: 'D', localName, valueXml: '' };
      expect(getLivePropertyValue(null, property)).toBeUndefined();
      const xml = generatePropfindResponse(null, 'prop', [property]);
      // Reported in the 404 propstat, not rendered as a value.
      expect(xml).toContain('<href>/</href>');
      expect(xml).toContain('HTTP/1.1 404 Not Found');
    });
  }

  it('still resolves genuine DAV: live properties', () => {
    expect(getLivePropertyValue(null, { namespaceURI: 'DAV:', prefix: '', localName: 'getcontentlength', valueXml: '' })).toBe('0');
    expect(getLivePropertyValue(null, { namespaceURI: 'DAV:', prefix: '', localName: 'resourcetype', valueXml: '' })).toBe(
      '<collection />',
    );
  });

  it('ignores non-DAV namespaces entirely', () => {
    expect(getLivePropertyValue(null, { namespaceURI: 'urn:x', prefix: 'x', localName: 'constructor', valueXml: '' })).toBeUndefined();
  });
});

describe('DavLockGuard fails closed on lookup errors', () => {
  const throwing = {
    exec: () => {
      throw new Error('dav_locks unavailable');
    },
  };

  it('propagates a storage failure instead of reporting "unlocked"', () => {
    const guard = new DavLockGuard(throwing as never);
    // Swallowing this and returning null silently downgraded Class 2 to
    // Class 1: every locked resource became writable.
    expect(() => guard.assertLock(new Request('https://x/'), 'a/b')).toThrow(/dav_locks unavailable/);
  });

  it('propagates a storage failure from activeTokensForPath', () => {
    const guard = new DavLockGuard(throwing as never);
    expect(() => guard.activeTokensForPath('a/b', [])).toThrow(/dav_locks unavailable/);
  });
});

describe('VolumeService.createVolume owner check fails closed', () => {
  const service = (resolveAccount: () => Promise<unknown>) =>
    new VolumeService(
      { DB: {} as never },
      {
        volumeDAO: () =>
          Promise.resolve({
            countByOwnerUserId: async () => 0,
            getByOwnerName: async () => null,
            getById: async () => null,
            create: async () => undefined,
          } as never),
        identity: () => Promise.resolve({ resolveAccount } as never),
        credentialDAO: () => Promise.resolve({} as never),
      },
    );

  it('rejects when the caller has no provisioned username', async () => {
    // Previously `resolveCallerUsername` returned null here and the check
    // `if (callerUsername && owner !== callerUsername)` was skipped entirely.
    const svc = service(async () => ({ id: 'usr_a', email: 'a@x.co', anchorEmail: 'a@x.co', username: null }));
    await expect(svc.createVolume({ owner: 'victim', name: 'photos', creatorEmail: 'a@x.co' })).rejects.toThrow(
      /No username is provisioned/,
    );
  });

  it('rejects when the account lookup throws', async () => {
    const svc = service(async () => {
      throw new Error('D1 down');
    });
    await expect(svc.createVolume({ owner: 'victim', name: 'photos', creatorEmail: 'a@x.co' })).rejects.toThrow(/No account is provisioned/);
  });

  it('rejects a mismatched owner', async () => {
    const svc = service(async () => ({ id: 'usr_a', email: 'a@x.co', anchorEmail: 'a@x.co', username: 'alice' }));
    await expect(svc.createVolume({ owner: 'victim', name: 'photos', creatorEmail: 'a@x.co' })).rejects.toThrow(/Only the bucket owner/);
  });
});

describe('metadata cascade prefix matching is wildcard-free', () => {
  function recordingSql() {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    return {
      statements,
      sql: {
        exec: (sql: string, ...bindings: unknown[]) => {
          statements.push({ sql, bindings });
          return { toArray: () => [] };
        },
      },
    };
  }

  it('deletes a subtree with a length-bounded prefix, not LIKE', () => {
    // `_` is legal in bucket/file names and is a LIKE single-character
    // wildcard, so `LIKE 'report_2024/%'` also matched `reportX2024/...` —
    // deleting rows for live files while keeping rows for deleted ones.
    const { statements, sql } = recordingSql();
    deleteNodeCascade(sql, 'report_2024');
    expect(statements).toHaveLength(3);
    for (const { sql: text } of statements) {
      expect(text).not.toContain('LIKE');
      expect(text).toContain('SUBSTR(path, 1, ?)');
    }
    expect(statements[0]?.bindings).toEqual(['report_2024', 'report_2024'.length + 1, 'report_2024/']);
  });

  it('keeps the replication base when a resource is deleted', () => {
    // `dav_replica_state` records where two trees last agreed, and for a DELETE that
    // record is the only evidence the path ever existed and is now gone. Cascading
    // it away lets the next sync pass read the surviving remote copy as a brand-new
    // file and pull it back — resurrecting what the user just deleted, while the
    // replication reports itself healthy. So the two cascade lists disagree about
    // this table on purpose.
    const { statements, sql } = recordingSql();
    deleteNodeCascade(sql, 'gone');
    expect(statements.map((entry) => entry.sql)).not.toContain('DELETE FROM dav_replica_state WHERE (path = ? OR SUBSTR(path, 1, ?) = ?)');
    expect(statements).toHaveLength(3);
  });

  it('renames a subtree with the same wildcard-free predicate', () => {
    const { statements, sql } = recordingSql();
    renameNodeCascade(sql, 'a_b', 'a_b2');
    // `dav_locks` is excluded, per RFC 4918 §7.6: "A successful MOVE request on a
    // write locked resource MUST NOT move the write lock with the resource."
    // Re-pathing it carried a lock out of the collection it was taken on and onto a
    // resource in a collection the locker never named.
    //
    // `dav_replica_state` *is* re-pathed, for the reason above: it travels with
    // the bytes rather than being left behind to describe a path that no longer
    // exists. So three tables, one of them specifically not `dav_locks`.
    expect(statements).toHaveLength(3);
    for (const { sql: text } of statements) {
      expect(text).not.toContain('LIKE');
      expect(text).not.toContain('dav_locks');
    }
    expect(statements.map((entry) => entry.sql)).toContain(
      'UPDATE dav_replica_state SET path = ? || SUBSTR(path, ?) WHERE (path = ? OR SUBSTR(path, 1, ?) = ?)',
    );
    // `to` and the suffix offset come first, then the subtree bindings.
    expect(statements[0]?.bindings).toEqual(['a_b2', 'a_b'.length + 1, 'a_b', 'a_b'.length + 1, 'a_b/']);
  });

  it('truncates the whole metadata store for the volume root', () => {
    const { statements, sql } = recordingSql();
    deleteNodeCascade(sql, '');
    expect(statements.map((s) => s.sql)).toEqual(['DELETE FROM dav_nodes', 'DELETE FROM dav_props', 'DELETE FROM dav_locks']);
  });
});
