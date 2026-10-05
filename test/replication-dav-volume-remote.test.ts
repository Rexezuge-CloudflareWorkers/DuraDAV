import { describe, expect, it } from 'vitest';
import { DavVolumeRemote } from '../apps/background/src/replication/remote/DavVolumeRemote';
import { RemoteUnavailableError } from '@durable-dav/backend-services/replication';

/**
 * The sibling-bucket adapter, directly.
 *
 * The round trip through a real Durable Object is covered by
 * `VolumeReplication.int.test.ts`, and the runner's use of this adapter by
 * `replication-runner.test.ts`. Neither can see the *mapping*, which is the part
 * that went wrong twice while this was written: the first version rebased on the way
 * out and stripped on the way in, so with a configured `remotePath` every listed
 * entry carried an extra segment and every write resolved to the replication root
 * and refused. Both failures were silent — the sync reported a clean run having moved
 * nothing — so the mapping is pinned here in isolation.
 */

type Call = { op: string; arg?: string };

/**
Shape of one listed entry, with the fields the planner reads.
*/
type StubEntry = {
  path: string;
  isCollection: boolean;
  etag: string | null;
  mtime: number | null;
  size: number | null;
  contentType: string | null;
};

/**
 * Wrap listing entries in the production completeness envelope.
 *
 * Defaults to `complete: true`, which is what the DO reports when its read
 * succeeded. Tests that care about the failure mode pass `complete: false`
 * explicitly, so "this listing is trustworthy" is visible at every call site
 * rather than implied by the return type.
 *
 * Typed against `StubEntry` rather than a literal shape so `{ ...ENTRY, path }`
 * spreads keep their widened types — `as const` on the fixture would make every
 * caller's own object a type error.
 */
function listing(entries: StubEntry[], complete = true): { entries: StubEntry[]; complete: boolean } {
  return { entries, complete };
}

function stub(overrides: Partial<ReplicaStub> = {}): ReplicaStub & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    listReplicaChildren: async (path: string) => {
      calls.push({ op: 'list', arg: path });
      return listing([]);
    },
    readReplicaStream: async (path: string) => {
      calls.push({ op: 'get', arg: path });
      return new Response('bytes').body;
    },
    readReplicaBytes: async () => null,
    applyReplicaOperations: async (_id: string, operations: unknown[]) => {
      for (const operation of operations as Array<{ op: string; path?: string }>) calls.push({ op: operation.op, arg: operation.path });
      return { applied: 1, failed: 0, error: null };
    },
    ...overrides,
  };
}

interface ReplicaStub {
  /**
   * Returns a completeness flag alongside the entries, matching the production
   * contract. `listing()` is the helper every stub below uses so a partial
   * listing is expressible without each case spelling the wrapper by hand.
   */
  listReplicaChildren: (path: string) => Promise<{
    entries: Array<{ path: string; isCollection: boolean; etag: string | null; mtime: number | null; size: number | null; contentType: string | null }>;
    complete: boolean;
  }>;
  readReplicaStream: (path: string) => Promise<ReadableStream<Uint8Array> | null>;
  readReplicaBytes: (path: string) => Promise<Uint8Array | null>;
  applyReplicaOperations: (id: string, operations: unknown[]) => Promise<{ applied: number; failed: number; error: string | null }>;
}

const ENTRY = {
  isCollection: false,
  etag: '"v1"',
  mtime: 1000,
  size: 4,
  contentType: 'text/plain',
};

/**
 * Build an adapter over `target`.
 *
 * `getStub` records the `owner/volume` it was asked for, because a raw-case lookup
 * would fork a second Durable Object for the same bucket.
 */
function adapter(target: ReplicaStub, options: { owner?: string; volume?: string; remotePath?: string } = {}) {
  const asked: string[] = [];
  const owner = options.owner ?? 'alice';
  const volume = options.volume ?? 'backup';
  const remote = new DavVolumeRemote({
    getStub: (o, v) => {
      asked.push(`${o}/${v}`);
      return target;
    },
    owner,
    volume,
    remotePath: options.remotePath,
    replicationId: 'rep_1',
  });
  return { remote, asked };
}

describe('DavVolumeRemote — root mapping', () => {
  it('resolves the sibling through the owner/volume it was configured with', async () => {
    const { remote, asked } = adapter(stub(), { owner: 'bob', volume: 'photos' });
    await remote.probe();
    expect(asked).toEqual(['bob/photos']);
  });

  it('re-roots a listing into the caller namespace and drops the self entry', async () => {
    // The sibling answers in the *volume's* coordinates whatever collection it was
    // asked about, and includes that collection. Without both corrections the target's
    // subdirectory becomes a local directory and every entry matches no local path.
    const target = stub({
      listReplicaChildren: async () =>
        listing([
          { ...ENTRY, path: 'sub', isCollection: true },
          { ...ENTRY, path: 'sub/a.txt' },
        ]),
    });
    const { remote } = adapter(target, { remotePath: 'sub' });
    const listed = await remote.list('');
    expect(listed.entries.map((entry) => entry.path)).toEqual(['a.txt']);
  });

  it('keeps a nested listing under the caller path', async () => {
    const target = stub({
      listReplicaChildren: async () =>
        listing([
          { ...ENTRY, path: 'sub/nested', isCollection: true },
          { ...ENTRY, path: 'sub/nested/b.txt' },
        ]),
    });
    const { remote } = adapter(target, { remotePath: 'sub' });
    const listed = await remote.list('nested');
    expect(listed.entries.map((entry) => entry.path)).toEqual(['nested/b.txt']);
  });

  it('is the identity when no subdirectory is configured', async () => {
    const target = stub({
      listReplicaChildren: async () =>
        listing([
          { ...ENTRY, path: '', isCollection: true },
          { ...ENTRY, path: 'a.txt' },
        ]),
    });
    const { remote } = adapter(target);
    const listed = await remote.list('');
    expect(listed.entries.map((entry) => entry.path)).toEqual(['a.txt']);
  });

  it('reports a complete listing when the sibling says it read everything', async () => {
    const { remote } = adapter(stub());
    expect((await remote.list('')).complete).toBe(true);
  });

  it('propagates an incomplete listing instead of asserting its own completeness', async () => {
    // The regression: this adapter used to hardcode `complete: true` on the
    // reasoning that its own read "either succeeded or threw". The read did
    // throw — inside the DO, one layer down, where a degraded `listDir` had
    // already turned the failure into an empty array. The adapter's answer was
    // therefore a guess about a failure it never saw, and an empty listing plus
    // `complete: true` is precisely a mass deletion to the planner.
    const target = stub({ listReplicaChildren: async () => listing([], false) });
    const { remote } = adapter(target);
    expect((await remote.list('')).complete).toBe(false);
  });

  it('refuses to resolve a path containing ".."', async () => {
    // A path that has to be rewritten to be safe is one that was constructed to leave
    // the configured root — and in `keep-both` mode, to delete there too.
    const { remote } = adapter(stub(), { remotePath: 'sub' });
    await expect(remote.list('..')).rejects.toThrow(RemoteUnavailableError);
    await expect(remote.list('a/../../etc')).rejects.toThrow(RemoteUnavailableError);
    await expect(remote.readFile('../escape')).rejects.toThrow(/\.\./);
  });

  it('wraps a sibling listing failure so the sweep can tell it from an empty listing', async () => {
    // Conflating them is how a sync deletes a directory because one read failed.
    const target = stub({
      listReplicaChildren: async () => {
        throw new Error('dofs unavailable');
      },
    });
    const { remote } = adapter(target, { remotePath: 'sub' });
    await expect(remote.list('')).rejects.toThrow(RemoteUnavailableError);
  });
});

describe('DavVolumeRemote — reads and writes', () => {
  it('reads through the configured subdirectory', async () => {
    const target = stub();
    const { remote } = adapter(target, { remotePath: 'sub' });
    await remote.readFile('a.txt');
    expect(target.calls).toEqual([{ op: 'get', arg: 'sub/a.txt' }]);
  });

  it('stats by asking the parent collection', async () => {
    const target = stub({
      listReplicaChildren: async (path: string) => (listing(path === 'sub' ? [{ ...ENTRY, path: 'sub/a.txt' }] : [])),
    });
    const { remote } = adapter(target, { remotePath: 'sub' });
    expect((await remote.stat('a.txt'))?.path).toBe('a.txt');
    expect(await remote.stat('missing.txt')).toBeNull();
    // The root is not a resource the sync engine ever looks up.
    expect(await remote.stat('')).toBeNull();
  });

  it('treats "not in a partial listing" as unknown rather than absent', async () => {
    // `stat` is how the planner decides a remote path still exists. A listing that
    // provably did not reach the path leaves it genuinely unknown, and reporting
    // `null` here would let "could not see it" be read as "it is gone".
    const target = stub({ listReplicaChildren: async () => listing([], false) });
    const { remote } = adapter(target, { remotePath: 'sub' });
    await expect(remote.stat('a.txt')).rejects.toThrow(RemoteUnavailableError);
  });

  it('writes through the configured subdirectory', async () => {
    const target = stub();
    const { remote } = adapter(target, { remotePath: 'sub' });
    await remote.writeFile('a.txt', new Uint8Array([1]), { contentType: 'text/plain', ifMatch: '"v1"' });
    expect(target.calls).toEqual([{ op: 'write', arg: 'sub/a.txt' }]);
  });

  it('returns a null ETag, because the sibling recomputes it locally', async () => {
    const { remote } = adapter(stub(), { remotePath: 'sub' });
    // `null` tells the planner to re-read it on the next pass, which costs one listing
    // and is correct. Handing back a stale or invented value would be neither.
    expect(await remote.writeFile('a.txt', new Uint8Array([1]), { contentType: null, ifMatch: null })).toEqual({ etag: null });
  });

  it('creates and removes through the configured subdirectory', async () => {
    const target = stub();
    const { remote } = adapter(target, { remotePath: 'sub' });
    await remote.makeCollection('nested');
    await remote.remove('nested', { ifMatch: null, recursive: true });
    expect(target.calls).toEqual([
      { op: 'mkdir', arg: 'sub/nested' },
      { op: 'unlink', arg: 'sub/nested' },
    ]);
  });

  it('treats making the root a no-op', async () => {
    const target = stub();
    const { remote } = adapter(target, { remotePath: 'sub' });
    await remote.makeCollection('');
    expect(target.calls).toEqual([]);
  });

  it('refuses to write or delete the replication root', async () => {
    const { remote } = adapter(stub(), { remotePath: 'sub' });
    // The root is the target's subdirectory itself, and a sync that emptied it would
    // destroy whatever else replicates into that subdirectory.
    await expect(remote.writeFile('', new Uint8Array([1]), { contentType: null, ifMatch: null })).rejects.toThrow(/root/);
    await expect(remote.remove('', { ifMatch: null, recursive: true })).rejects.toThrow(/root/);
  });

  it('surfaces a sibling write failure rather than reporting success', async () => {
    const target = stub({
      applyReplicaOperations: async () => ({ applied: 0, failed: 1, error: 'quota exceeded' }),
    });
    const { remote } = adapter(target, { remotePath: 'sub' });
    await expect(remote.writeFile('a.txt', new Uint8Array([1]), { contentType: null, ifMatch: null })).rejects.toThrow(/quota exceeded/);
    await expect(remote.makeCollection('nested')).rejects.toThrow(/quota exceeded/);
    await expect(remote.remove('a.txt', { ifMatch: null, recursive: true })).rejects.toThrow(/quota exceeded/);
  });
});

describe('DavVolumeRemote — probe', () => {
  it('reads the configured subdirectory', async () => {
    const target = stub();
    const { remote } = adapter(target, { remotePath: 'sub' });
    // A sibling bucket is this same codebase, so its RFC 4918 compliance is not in
    // question the way a third-party server's is.
    await expect(remote.probe()).resolves.toEqual({ davClasses: ['1', '2'] });
    expect(target.calls).toEqual([{ op: 'list', arg: 'sub' }]);
  });

  it('reports an unreadable sibling by name', async () => {
    const target = stub({
      listReplicaChildren: async () => {
        throw new Error('gone');
      },
    });
    const { remote } = adapter(target, { owner: 'alice', volume: 'backup', remotePath: 'sub' });
    await expect(remote.probe()).rejects.toThrow(/alice\/backup/);
  });
});
