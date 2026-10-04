import { describe, expect, it } from 'vitest';
import { buildReplicationPlan, conflictWinner, conflictPathFor, provablyIdentical, sideChanged } from '@durable-dav/backend-services/replication';
import type { PlanBase, PlanSide } from '@durable-dav/backend-services/replication';

/**
 * The sync planner as a truth table.
 *
 * Every destructive decision in replication is made by `buildReplicationPlan`,
 * and it is a pure function over three arrays precisely so it can be exercised
 * like this. The cases below are the ones where getting it wrong destroys data:
 * a deletion inferred from an absence that meant nothing, a conflict resolved by
 * picking the side that happened to be iterated second, or an "unchanged" verdict
 * on missing evidence.
 */

const NOW = 1_700_000_000_000;

function side(path: string, overrides: Partial<PlanSide> = {}): PlanSide {
  return {
    path,
    isCollection: false,
    etag: `"${path}-v1"`,
    mtime: 1000,
    size: 10,
    contentType: 'text/plain',
    ...overrides,
  };
}

function collection(path: string): PlanSide {
  return side(path, { isCollection: true, etag: null, size: null });
}

function base(path: string, overrides: Partial<PlanBase> = {}): PlanBase {
  return {
    path,
    isCollection: false,
    localEtag: `"${path}-v1"`,
    localMtime: 1000,
    localSize: 10,
    remoteEtag: `"${path}-v1"`,
    remoteMtime: 1000,
    remoteSize: 10,
    contentType: 'text/plain',
    ...overrides,
  };
}

function kinds(decisions: readonly { kind: string; path: string }[]): string[] {
  return decisions.map((decision) => `${decision.kind} ${decision.path}`);
}

describe('buildReplicationPlan — first contact with a path', () => {
  it('pushes a file that exists only locally, in every mode', () => {
    // Including `copy-only`: a mirror that refuses new files is not a mirror.
    for (const mode of ['keep-both', 'sync', 'copy-only'] as const) {
      const plan = buildReplicationPlan({ mode, local: [side('a.txt')], remote: [], base: [], trustAbsences: true });
      expect(kinds(plan.decisions)).toEqual([`push a.txt`]);
    }
  });

  it('pulls a file that exists only remotely, except in copy-only', () => {
    for (const mode of ['keep-both', 'sync'] as const) {
      const plan = buildReplicationPlan({ mode, local: [], remote: [side('b.txt')], base: [], trustAbsences: true });
      expect(kinds(plan.decisions)).toEqual([`pull b.txt`]);
    }
    // The remote is a mirror; importing from it would let a corrupted copy
    // overwrite the original, so `copy-only` ignores it entirely.
    const plan = buildReplicationPlan({ mode: 'copy-only', local: [], remote: [side('b.txt')], base: [], trustAbsences: true });
    expect(plan.decisions).toEqual([]);
  });

  it('records agreement when both sides created an identical file', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('c.txt')],
      remote: [side('c.txt')],
      base: [],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['agree c.txt']);
    expect(plan.conflicts).toEqual([]);
  });

  it('orders collections before the files inside them', () => {
    // A pull writing `dir/file.txt` needs `dir` to exist first, and sorting by
    // path depth alone is not enough: a file and a collection can be the same
    // depth.
    const plan = buildReplicationPlan({
      mode: 'sync',
      local: [collection('dir'), side('dir/file.txt')],
      remote: [],
      base: [],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['push dir', 'push dir/file.txt']);
  });

  it('orders a deep pull parent-first across several levels', () => {
    const plan = buildReplicationPlan({
      mode: 'sync',
      local: [],
      remote: [side('a/b/c/deep.txt'), collection('a/b/c'), collection('a/b'), collection('a')],
      base: [],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['pull a', 'pull a/b', 'pull a/b/c', 'pull a/b/c/deep.txt']);
  });
});

describe('buildReplicationPlan — the deletion gate', () => {
  it('propagates a local deletion to the remote on a clean pass', () => {
    // Local is absent, remote still has it — so the deletion has to be applied to
    // the *remote*. The inverse would delete the only surviving copy and leave
    // nothing anywhere.
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [],
      remote: [side('gone.txt')],
      base: [base('gone.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['delete-remote gone.txt']);
    expect(plan.absencesDeferred).toBe(false);
  });

  it('propagates a remote deletion locally on a clean pass', () => {
    // Mirror image: the remote is the side that deleted it, so the local copy is
    // what has to go.
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('gone.txt')],
      remote: [],
      base: [base('gone.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['delete-local gone.txt']);
  });

  it('refuses every deletion when the pass was not clean', () => {
    // The whole point of the gate: an absence observed through an incomplete
    // listing is not evidence of anything, and deleting on one destroys data on
    // both sides at once. Each path is present on one side only — that is what a
    // pending deletion looks like.
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [],
      remote: [side('a.txt'), side('b.txt'), side('c.txt')],
      base: [base('a.txt'), base('b.txt'), base('c.txt')],
      trustAbsences: false,
    });
    expect(plan.decisions).toEqual([]);
    expect(plan.deferredPaths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(plan.absencesDeferred).toBe(true);
  });

  it('records a propagated deletion in the conflict log', () => {
    // Deletions are the irreversible ones, so they are attributable afterwards.
    // The remote deleted it and the local copy survives, so `winner` is `local`.
    const plan = buildReplicationPlan({
      mode: 'sync',
      local: [side('x.txt')],
      remote: [],
      base: [base('x.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['delete-local x.txt']);
    // The kind is stated, not inferred from the absence of a conflict copy — the two
    // used to be the same thing, which logged a resolved conflict as a deletion.
    expect(plan.conflicts).toEqual([{ path: 'x.txt', winner: 'local', kind: 'deletion', conflictPath: null }]);
  });

  it('forgets a path that is gone from both sides and the base', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [],
      remote: [],
      base: [base('vanished.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['forget vanished.txt']);
  });

  it('does NOT forget when an absence is untrusted — the record must survive', () => {
    // The subtlest data loss in this feature, and the reason `trustAbsences` gates
    // `forget` as well as deletions: a listing that failed makes one side look
    // empty, so a path absent from both sides looks deleted everywhere. Dropping
    // its base row loses the only record that the file existed, and the next pass
    // then treats the remote's copy as brand new and pushes over it.
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [],
      remote: [],
      base: [base('still-there.txt')],
      trustAbsences: false,
    });
    expect(plan.decisions).toEqual([]);
    expect(plan.deferredPaths).toEqual(['still-there.txt']);
    expect(plan.absencesDeferred).toBe(true);
  });

  it('emits deletions deepest-first so a subtree empties before its parent', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [],
      // The subtree was deleted locally; the remote still has all of it.
      remote: [collection('dir'), side('dir/a.txt'), side('dir/b.txt')],
      base: [base('dir', { isCollection: true, localEtag: null, localSize: null }), base('dir/a.txt'), base('dir/b.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['delete-remote dir/a.txt', 'delete-remote dir/b.txt', 'delete-remote dir']);
  });
});

describe('buildReplicationPlan — three-way comparison', () => {
  it('does nothing when neither side changed', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt')],
      remote: [side('a.txt')],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['agree a.txt']);
    expect(plan.conflicts).toEqual([]);
  });

  it('pushes when only the local side changed', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt', { etag: '"a-v2"' })],
      remote: [side('a.txt')],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['push a.txt']);
  });

  it('pulls when only the remote side changed', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt')],
      remote: [side('a.txt', { etag: '"a-v2-remote"' })],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['pull a.txt']);
  });

  it('ignores a remote-only change in copy-only mode', () => {
    const plan = buildReplicationPlan({
      mode: 'copy-only',
      local: [side('a.txt')],
      remote: [side('a.txt', { etag: '"a-v2-remote"' })],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['agree a.txt']);
  });

  it('keeps both sides when a path became a collection on one and a file on the other', () => {
    // A file and a collection cannot both live at one path, so there is no
    // "winner" to pick and no overwrite that preserves anything. This is a
    // structural conflict rather than a content one, and `keep-both` is the only
    // non-destructive answer — `push` here would require deleting a live resource
    // first, which is the failure mode this whole module avoids.
    const plan = buildReplicationPlan({
      mode: 'sync',
      local: [side('thing')],
      remote: [collection('thing')],
      base: [base('thing', { isCollection: true, localEtag: null, localSize: null })],
      trustAbsences: true,
      now: NOW,
    });
    expect(plan.decisions[0]?.kind).toBe('keep-both');
  });
});

describe('buildReplicationPlan — conflicts', () => {
  it('writes a conflict copy rather than overwriting, in keep-both', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt', { etag: '"local-v2"' })],
      remote: [side('a.txt', { etag: '"remote-v2"' })],
      base: [base('a.txt')],
      trustAbsences: true,
      now: NOW,
    });
    expect(plan.decisions).toHaveLength(1);
    const decision = plan.decisions[0];
    expect(decision?.kind).toBe('keep-both');
    if (decision?.kind === 'keep-both') {
      // A sibling, not a `conflict/` subtree: the person resolving this is
      // looking at the directory, not hunting through a tree.
      expect(decision.conflictPath).toBe(`a.txt.conflict-${Math.floor(NOW / 1000)}`);
    }
    expect(plan.conflicts[0]).toMatchObject({ kind: 'conflict', conflictPath: `a.txt.conflict-${Math.floor(NOW / 1000)}` });
  });

  it('resolves by newer mtime in sync mode', () => {
    const newerLocal = buildReplicationPlan({
      mode: 'sync',
      local: [side('a.txt', { etag: '"local-v2"', mtime: 2000 })],
      remote: [side('a.txt', { etag: '"remote-v2"', mtime: 1500 })],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(newerLocal.decisions)).toEqual(['push a.txt']);

    const newerRemote = buildReplicationPlan({
      mode: 'sync',
      local: [side('a.txt', { etag: '"local-v2"', mtime: 1500 })],
      remote: [side('a.txt', { etag: '"remote-v2"', mtime: 2000 })],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(newerRemote.decisions)).toEqual(['pull a.txt']);
  });

  it('falls back to keep-both when sync cannot decide — never a coin flip', () => {
    // Equal timestamps, and a remote with no timestamp at all, are both
    // undecidable. Picking by iteration order would be the one outcome nobody
    // could debug.
    for (const remoteMtime of [1000, null]) {
      const plan = buildReplicationPlan({
        mode: 'sync',
        local: [side('a.txt', { etag: '"local-v2"', mtime: 1000 })],
        remote: [side('a.txt', { etag: '"remote-v2"', mtime: remoteMtime })],
        base: [base('a.txt')],
        trustAbsences: true,
        now: NOW,
      });
      expect(plan.decisions[0]?.kind).toBe('keep-both');
    }
  });

  it('records a sync conflict resolved by timestamp as a conflict, not a deletion', () => {
    // `sync` discards the loser, so no conflict copy is written — and the runner used
    // to read that absence as "a deletion happened". In the audit trail, the two
    // answer different questions: one is a merge that was decided, the other is data
    // that no longer exists on either side.
    const plan = buildReplicationPlan({
      mode: 'sync',
      local: [side('a.txt', { etag: '"local-v2"', mtime: 2000 })],
      remote: [side('a.txt', { etag: '"remote-v2"', mtime: 3000 })],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['pull a.txt']);
    expect(plan.conflicts).toEqual([{ path: 'a.txt', winner: 'remote', kind: 'conflict', conflictPath: null }]);
  });

  it('gives the local side the win in copy-only mode', () => {
    const plan = buildReplicationPlan({
      mode: 'copy-only',
      local: [side('a.txt', { etag: '"local-v2"' })],
      remote: [side('a.txt', { etag: '"remote-v2"' })],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    expect(kinds(plan.decisions)).toEqual(['push a.txt']);
  });

  it('never generates a conflict path that collides with a live resource', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt', { etag: '"local-v2"' }), side(`a.txt.conflict-${Math.floor(NOW / 1000)}`)],
      remote: [side('a.txt', { etag: '"remote-v2"' })],
      base: [base('a.txt')],
      trustAbsences: true,
      now: NOW,
    });
    const decision = plan.decisions.find((entry) => entry.kind === 'keep-both');
    if (decision?.kind !== 'keep-both') throw new Error('expected a keep-both decision');
    // The pre-existing file at the natural conflict name must win the name; the
    // generated one has to step aside rather than overwrite it.
    expect(decision.conflictPath).not.toBe(`a.txt.conflict-${Math.floor(NOW / 1000)}`);
    expect(decision.conflictPath).toMatch(/^a\.txt\.conflict-\d+(-2)?$/);
  });

  it('declines to hash an ambiguous pair unless asked', () => {
    // Equal size, disagreeing validators, no hash requested: this must be a
    // conflict, never an assumed match. Assuming equal size means equal content
    // is exactly the silent data loss this feature must not have.
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt', { etag: null, mtime: 1000, size: 42 })],
      remote: [side('a.txt', { etag: null, mtime: 9999, size: 42 })],
      base: [],
      trustAbsences: true,
    });
    expect(plan.decisions[0]?.kind).toBe('keep-both');
  });

  it('defers to the runner for hashing when hashOnAmbiguous is on', () => {
    const plan = buildReplicationPlan({
      mode: 'keep-both',
      local: [side('a.txt', { etag: null, mtime: 1000, size: 42 })],
      remote: [side('a.txt', { etag: null, mtime: 9999, size: 42 })],
      base: [],
      trustAbsences: true,
      hashOnAmbiguous: true,
    });
    expect(plan.decisions[0]?.kind).toBe('compare-content');
  });
});

describe('helpers', () => {
  it('sideChanged answers "changed" whenever evidence is missing', () => {
    // Conservative in one direction only: a false *changed* costs one redundant
    // transfer, a false *unchanged* costs a lost edit.
    expect(sideChanged({ etag: null, mtime: null, size: null, isCollection: false }, { etag: '"a"', mtime: 1, size: 1, isCollection: false })).toBe(true);
    expect(sideChanged({ etag: '"a"', mtime: 1, size: 1, isCollection: false }, { etag: '"a"', mtime: 1, size: 1, isCollection: false })).toBe(false);
    expect(sideChanged({ etag: '"a"', mtime: 1, size: 2, isCollection: false }, { etag: '"a"', mtime: 1, size: 1, isCollection: false })).toBe(true);
  });

  it('provablyIdentical only answers yes on positive evidence', () => {
    const a = side('a.txt', { etag: null, mtime: null, size: 10 });
    const b = side('a.txt', { etag: null, mtime: null, size: 10 });
    // Neither side offers a validator or a timestamp: there is nothing to compare.
    expect(provablyIdentical(a, b)).toBe(false);
    // A matching strong ETag plus size is proof.
    expect(provablyIdentical(side('a.txt'), side('a.txt'))).toBe(true);
    // Two collections at the same path are the same collection.
    expect(provablyIdentical(collection('d'), collection('d'))).toBe(true);
  });

  it('conflictWinner returns null rather than guessing', () => {
    const a = side('a.txt', { mtime: 5 });
    const b = side('a.txt', { mtime: 5 });
    expect(conflictWinner(a, b, 'sync')).toBeNull();
    expect(conflictWinner(a, side('a.txt', { mtime: null }), 'sync')).toBeNull();
    expect(conflictWinner(a, b, 'copy-only')).toBe('local');
    expect(conflictWinner(a, side('a.txt', { mtime: 9 }), 'keep-both')).toBeNull();
  });

  it('conflictPathFor truncates a long name rather than producing an unusable path', () => {
    const long = `${'n'.repeat(400)}.txt`;
    const path = conflictPathFor(long, new Set(), 1_700_000_000);
    expect(path.startsWith('n'.repeat(180))).toBe(true);
    expect(path.endsWith('.conflict-1700000000')).toBe(true);
  });
});
