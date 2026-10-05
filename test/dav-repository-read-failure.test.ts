import { describe, expect, it } from 'vitest';
import { DavRepository } from '../apps/background/src/dav/DavRepository';
import type { DofsFs, DurableSqlStorage } from '@durable-dav/dav-store';

/**
 * `DavRepository`'s two read policies, and the pairing between them.
 *
 * The repository answers a failed dofs read in one of two ways, and the choice is
 * a correctness decision rather than an error-handling detail:
 *
 * - the degrading form answers `[]` / `exists: false`, which is right for
 *   "render this collection" and
 * - the `require` form throws, which is the only safe answer for a caller that
 *   will *act on an absence*.
 *
 * They had drifted: `VolumeReplicationRpc` called `listChildren` inside a block
 * whose own comment asserted it threw, and `replicaOperations.describe` called
 * `statInner`. Both degraded a storage error into "this is gone", which the sync
 * planner reads as a deletion. So these are pinned here at the layer the choice
 * is made — one test per policy per operation, plus the pairing that fails the
 * regression.
 *
 * The dofs fake throws on demand rather than modelling a real volume, because the
 * behaviour under test is precisely "what does this method do when the read
 * fails", and a real `Fs` over a Durable Object's storage cannot be made to fail
 * on cue without a DO.
 */

/**
 * Only the two reads this file exercises, narrowed to what they return.
 *
 * Spelled as a standalone type rather than a widened `DofsFs` because `DofsFs`'s
 * real `stat` returns dofs' full `Stat` and a partial literal would not satisfy
 * it. The cast at each construction site is then a single, visible widening.
 */
type FakeDofs = {
  stat: (path: string) => { isDirectory: boolean; size?: number; mtime?: number };
  listDir: (path: string, options?: { recursive?: boolean }) => string[];
};

/**
 * A dofs whose reads succeed until `failWith` is armed, then throw.
 *
 * `files` is keyed by **inner** path (`docs`) because that is what the repository
 * is called with; `fsPathOf` has already turned it into `/docs` by the time it
 * reaches dofs, and the fake converts back so the fixtures read in the same
 * vocabulary as the code under test.
 */
function dofs(failWith: { armed: boolean }, files: Record<string, string[]> = {}): FakeDofs {
  // Every path the fake tree contains, so `stat` can tell "missing" from
  // "unreadable" the way a real `dofs` does. A real `stat` throws `ENOENT` for an
  // absent path and the repository turns that into `exists: false`; a fake that
  // answered every `stat` would collapse the two and make the `require` variants
  // indistinguishable from the degrading ones.
  const present = new Set<string>(['']);
  for (const [dir, names] of Object.entries(files)) {
    present.add(dir);
    for (const name of names) {
      present.add(dir === '' ? name : `${dir}/${name}`);
      present.add(dir === '' ? `${name}/deep.txt` : `${dir}/${name}/deep.txt`);
    }
  }
  return {
    stat: (path: string) => {
      if (failWith.armed) throw new Error('dofs unavailable');
      const inner = path.replace(/^\//, '');
      if (!present.has(inner)) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      const isDirectory = files[inner] !== undefined || inner === '';
      return { isDirectory, size: 0, mtime: 1000 };
    },
    listDir: (path: string, options?: { recursive?: boolean }) => {
      if (failWith.armed) throw new Error('dofs unavailable');
      const inner = path.replace(/^\//, '');
      const names = files[inner] ?? [];
      if (options?.recursive === true) {
        // Flatten every descendant, so the recursive and non-recursive reads are
        // distinguishable in the assertions below.
        return ['.', '..', ...names.flatMap((name) => [name, `${name}/deep.txt`])];
      }
      return ['.', '..', ...names];
    },
  };
}

/**
SQLite that answers every query with no rows, which is what a fresh volume looks like.
*/
function sql(): DurableSqlStorage {
  return { exec: () => ({ toArray: () => [], one: () => undefined }) } as unknown as DurableSqlStorage;
}

function repository(failWith?: { armed: boolean }, files?: Record<string, string[]>): DavRepository {
  return new DavRepository(dofs(failWith ?? { armed: false }, files) as unknown as DofsFs, sql());
}

describe('DavRepository — reads a caller will act on', () => {
  it('throws from requireChildren when the listing fails', () => {
    // The regression, at the layer the bug lived. A caller that reads absences
    // from this listing gets an error; it never receives an empty collection that
    // it would interpret as "everything in here was deleted".
    const repo = repository({ armed: true });
    expect(() => repo.requireChildren('docs')).toThrow('dofs unavailable');
  });

  it('throws from requireRecursive when the listing fails', () => {
    const repo = repository({ armed: true });
    expect(() => repo.requireRecursive('docs')).toThrow('dofs unavailable');
  });

  it('throws from requireStatInner when the stat fails', () => {
    const repo = repository({ armed: true });
    expect(() => repo.requireStatInner('a.txt')).toThrow('dofs unavailable');
  });

  it('still returns the real listing when the read succeeds', () => {
    // The `require` variants are not "always throw" — a passing read must answer
    // normally, or a working bucket would be reported as broken.
    const repo = repository({ armed: false }, { docs: ['a.txt', 'b.txt'] });
    expect(repo.requireChildren('docs').sort()).toEqual(['a.txt', 'b.txt']);
    expect(repo.requireStatInner('docs/a.txt').exists).toBe(true);
  });

  it('reports a genuinely missing path as absent rather than throwing', () => {
    // `require` is about *failed reads*, not about absence. A path that simply is
    // not there is an answer, and the sync engine has to be able to receive it.
    const repo = repository({ armed: false }, { docs: ['a.txt'] });
    expect(repo.requireChildren('docs')).toEqual(['a.txt']);
    expect(repo.requireStatInner('nope.txt')).toMatchObject({ exists: false });
  });

  it('still separates an unreadable path from a missing one', () => {
    // The reason that separation exists. `dofs` throws `ENOENT` for a missing path
    // and a plain error for an unreadable one; both policies answer "missing" the
    // same way, but only one of them answers "unreadable" with `exists: false`.
    const missing = repository({ armed: false }, { docs: ['a.txt'] });
    const unreadable = repository({ armed: true });
    expect(missing.requireStatInner('nope.txt').exists).toBe(false);
    expect(() => unreadable.requireStatInner('nope.txt')).toThrow('dofs unavailable');
    expect(unreadable.statInner('nope.txt').exists).toBe(false);
  });

  it('does not mistake an unrelated failure for absence', () => {
    // The regression a loose `/not found/i` would cause: a DNS or transport error
    // whose message happens to contain those words would be classified as "the file
    // is gone", and the sync engine would act on that.
    const repo = new DavRepository(
      {
        stat: () => {
          throw new Error('getaddrinfo host not found');
        },
        listDir: () => [],
      } as unknown as DofsFs,
      sql(),
    );
    expect(() => repo.requireStatInner('a.txt')).toThrow(/host not found/);
  });
});

describe('DavRepository — reads for rendering', () => {
  it('degrades listChildren to an empty listing', () => {
    const repo = repository({ armed: true });
    expect(repo.listChildren('docs')).toEqual([]);
  });

  it('degrades listRecursive to an empty listing', () => {
    const repo = repository({ armed: true });
    expect(repo.listRecursive('docs')).toEqual([]);
  });

  it('degrades statInner to "does not exist"', () => {
    const repo = repository({ armed: true });
    expect(repo.statInner('a.txt')).toMatchObject({ exists: false });
  });

  it('degrades readMeta to no metadata, so a node without a row still reads', () => {
    // A node whose metadata row is missing is normal on a fresh volume — `statInner`
    // supplies the fallback. Degrading is what lets that case work at all.
    const repo = repository({ armed: true });
    expect(repo.readMeta('a.txt')).toEqual({});
  });
});

describe('DavRepository — listing shapes', () => {
  it('drops the "." and ".." entries dofs returns', () => {
    // Without this filter every listing renders two phantom entries that no
    // client can address, and the planner treats them as real paths.
    const repo = repository({ armed: false }, { '': ['real.txt'] });
    expect(repo.requireChildren('')).not.toContain('.');
    expect(repo.requireChildren('')).not.toContain('..');
    expect(repo.requireChildren('')).toContain('real.txt');
  });

  it('distinguishes the recursive walk from the single-collection read', () => {
    // The two are separate methods because they answer different questions: one
    // collection for a resumable sweep, the whole subtree for "is any descendant
    // locked". A stub that made them identical would hide a wrong call site.
    const repo = repository({ armed: false }, { docs: ['a.txt'] });
    expect(repo.requireChildren('docs').sort()).toEqual(['a.txt']);
    expect(repo.requireRecursive('docs').some((name) => name.includes('/deep.txt'))).toBe(true);
  });

  it('reports an empty collection as empty on both variants', () => {
    // The degradation that is safe: a collection that genuinely has no children
    // and a collection whose read failed must be distinguishable by *how* you ask,
    // never collapsed into the same answer.
    const repo = repository({ armed: false }, { docs: [] });
    expect(repo.requireChildren('docs')).toEqual([]);
    expect(repo.requireRecursive('docs')).toEqual([]);
  });

  it('treats a collection that was never created as empty, not as a failure', () => {
    // A replication's very first listing of a configured `remotePath` asks about a
    // subdirectory that does not exist yet, and that is a normal state. If `ENOENT`
    // counted as a failure here the `require` variants would fail every first sync
    // — which is the shape a fix for the gate bug takes when it is drawn too wide.
    const repo = repository({ armed: false }, {});
    expect(repo.requireChildren('never-created')).toEqual([]);
    expect(repo.requireRecursive('never-created')).toEqual([]);
    expect(repo.listChildren('never-created')).toEqual([]);
  });

  it('still throws on a listing failure for a collection that does exist', () => {
    // The distinction that keeps the case above honest: absent collection is an
    // answer, unreadable collection is a fault.
    const repo = new DavRepository(
      {
        stat: () => ({ isDirectory: true, size: 0, mtime: 1000 }),
        listDir: () => {
          throw new Error('dofs unavailable');
        },
      } as unknown as DofsFs,
      sql(),
    );
    expect(() => repo.requireChildren('docs')).toThrow('dofs unavailable');
  });
});
