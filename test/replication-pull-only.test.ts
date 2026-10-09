import { describe, expect, it } from 'vitest';
import { buildReplicationPlan, conflictWinner } from '@durable-dav/backend-services/replication';
import type { PlanBase, PlanSide, ReplicationDecision } from '@durable-dav/backend-services/replication';

/**
 * `pull-only`: the mode where the *remote* is the sole writer.
 *
 * The invariant this file exists to protect is one sentence: **a `pull-only` plan
 * never contains a decision that writes to the remote.** Not "rarely", not "except
 * in a conflict" — never. Every branch below is checked against it, including the
 * exhaustive sweep at the end, because a single `push` reaching the executor would
 * copy the owner's files to a target whose entire definition is that it is not
 * written to.
 *
 * The second invariant is adjacent and equally load-bearing: a local edit is never
 * silently overwritten. The remote wins on *precedence*, and the loser is preserved
 * beside the path — so "the remote is authoritative" stays a statement about who
 * decides rather than about whose work disappears.
 */

const NOW = 1_700_000_000_000;

function side(path: string, overrides: Partial<PlanSide> = {}): PlanSide {
  return { path, isCollection: false, etag: `"${path}-v1"`, mtime: 1000, size: 10, contentType: 'text/plain', ...overrides };
}

function localOnly(path: string): PlanSide {
  return side(path, { etag: '"local-v2"', mtime: 2000 });
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

function kinds(decisions: readonly ReplicationDecision[]): string[] {
  return decisions.map((decision) => `${decision.kind} ${decision.path}`);
}

/**
 * The one invariant, as an assertion.
 */
function assertNeverWritesUpstream(decisions: readonly ReplicationDecision[]): void {
  const upstream = decisions.filter((decision) => decision.kind === 'push' || decision.kind === 'delete-remote');
  expect(upstream.map((d) => `${d.kind} ${d.path}`)).toEqual([]);
}

function plan(input: {
  local?: PlanSide[];
  remote?: PlanSide[];
  base?: PlanBase[];
  trustAbsences?: boolean;
  mirrorDeletions?: boolean;
}) {
  return buildReplicationPlan({
    mode: 'pull-only',
    local: input.local ?? [],
    remote: input.remote ?? [],
    base: input.base ?? [],
    trustAbsences: input.trustAbsences ?? true,
    mirrorDeletions: input.mirrorDeletions,
    now: NOW,
  });
}

describe('pull-only — the remote is the sole writer', () => {
  it('imports a file that exists only remotely', () => {
    const result = plan({ remote: [side('a.txt')] });
    expect(kinds(result.decisions)).toEqual(['pull a.txt']);
    assertNeverWritesUpstream(result.decisions);
  });

  it('never pushes a file created locally', () => {
    const result = plan({ local: [side('a.txt')] });
    // Not `push`, and not `delete-local` either: without `mirrorDeletions` this
    // emits nothing at all.
    expect(result.decisions).toEqual([]);
    assertNeverWritesUpstream(result.decisions);
  });

  it('never deletes a local file the remote lacks, without mirrorDeletions', () => {
    // The base row says both sides had it; the remote has since lost it. A safe copy
    // keeps the owner's file — a remote that has dropped something must not be able
    // to delete the only surviving copy.
    const result = plan({ local: [side('a.txt')], base: [base('a.txt')] });
    expect(kinds(result.decisions)).toEqual([]);
    assertNeverWritesUpstream(result.decisions);
  });

  it('restores a file deleted here when the remote still has it', () => {
    const result = plan({ remote: [side('a.txt')], base: [base('a.txt')] });
    expect(kinds(result.decisions)).toEqual(['pull a.txt']);
    assertNeverWritesUpstream(result.decisions);
  });

  it('preserves a local edit rather than overwriting it', () => {
    // Local changed, remote did not. The remote's version wins — but the local bytes
    // are kept at a sibling path, so the owner's edit is recoverable.
    const result = plan({ local: [localOnly('a.txt')], remote: [side('a.txt')], base: [base('a.txt')] });
    expect(kinds(result.decisions)).toEqual(['pull-and-preserve a.txt']);
    assertNeverWritesUpstream(result.decisions);

    const decision = result.decisions[0];
    if (decision?.kind !== 'pull-and-preserve') throw new Error('expected pull-and-preserve');
    // `<stem>.conflict-<seconds>`: the sibling name the owner looks for when they need
// the version this bucket did not have.
// `<name>.conflict-<seconds>` — the stem is the full filename, so the sibling sits
// next to the original rather than in a `conflict/` subtree.
expect(decision.conflictPath).toBe(`a.txt.conflict-${Math.floor(NOW / 1000)}`);
    // Recorded as a conflict with the remote as winner, so the decision trail
    // attributes the surviving copy.
    expect(result.conflicts).toEqual([{ path: 'a.txt', winner: 'remote', kind: 'conflict', conflictPath: decision.conflictPath }]);
  });

  it('preserves the local side when both changed', () => {
    const result = plan({
      local: [localOnly('a.txt')],
      remote: [side('a.txt', { etag: '"remote-v3"', mtime: 3000 })],
      base: [base('a.txt')],
    });
    expect(kinds(result.decisions)).toEqual(['pull-and-preserve a.txt']);
    assertNeverWritesUpstream(result.decisions);
  });

  it('keeps the newer local copy rather than pushing it, when both sides created a file', () => {
    const result = plan({ local: [localOnly('a.txt')], remote: [side('a.txt', { etag: '"remote-v3"' })] });
    expect(kinds(result.decisions)).toEqual(['pull-and-preserve a.txt']);
    assertNeverWritesUpstream(result.decisions);
  });

  it('records agreement when the two sides are provably identical', () => {
    const result = plan({ local: [side('a.txt')], remote: [side('a.txt')] });
    expect(kinds(result.decisions)).toEqual(['agree a.txt']);
    // No conflict row: nothing was reconciled.
    expect(result.conflicts).toEqual([]);
    assertNeverWritesUpstream(result.decisions);
  });

  it('pulls a remote change the local side never made', () => {
    const result = plan({
      local: [side('a.txt')],
      remote: [side('a.txt', { etag: '"remote-v3"' })],
      base: [base('a.txt')],
    });
    expect(kinds(result.decisions)).toEqual(['pull a.txt']);
    assertNeverWritesUpstream(result.decisions);
  });

  it('orders an import parent-first', () => {
    const result = plan({ remote: [side('a/b/c/deep.txt'), collection('a/b/c'), collection('a/b'), collection('a')] });
    expect(kinds(result.decisions)).toEqual(['pull a', 'pull a/b', 'pull a/b/c', 'pull a/b/c/deep.txt']);
    assertNeverWritesUpstream(result.decisions);
  });
});

describe('pull-only — mirrorDeletions', () => {
  it('removes a local file the remote does not have', () => {
    const result = plan({ local: [side('a.txt')], base: [base('a.txt')], mirrorDeletions: true });
    expect(kinds(result.decisions)).toEqual(['delete-local a.txt']);
    assertNeverWritesUpstream(result.decisions);
    // Attributable afterwards, which is why `kind` is stated rather than inferred.
    expect(result.conflicts).toEqual([{ path: 'a.txt', winner: 'remote', kind: 'deletion', conflictPath: null }]);
  });

  it('removes a local file the remote never had', () => {
    // No base row: the file was created here and the remote has never seen it. An
    // exact mirror is exactly this — the local tree must end up equal to the remote's.
    const result = plan({ local: [side('a.txt')], mirrorDeletions: true });
    expect(kinds(result.decisions)).toEqual(['delete-local a.txt']);
  });

  it('still never deletes on an untrusted pass', () => {
    // The gate is not specific to two-way deletions. A failed listing makes the
    // remote look empty, and acting on that would empty this bucket.
    const result = plan({ local: [side('a.txt')], base: [base('a.txt')], mirrorDeletions: true, trustAbsences: false });
    expect(result.decisions).toEqual([]);
    expect(result.deferredPaths).toEqual(['a.txt']);
    expect(result.absencesDeferred).toBe(true);
  });

  it('reports an untrusted absence as deferred even when it decides nothing', () => {
    const result = plan({ local: [side('a.txt')], base: [base('a.txt')], trustAbsences: false });
    expect(result.decisions).toEqual([]);
    expect(result.deferredPaths).toEqual(['a.txt']);
  });

  it('forgets a path gone from both sides', () => {
    const result = plan({ base: [base('a.txt')], mirrorDeletions: true });
    expect(kinds(result.decisions)).toEqual(['forget a.txt']);
    assertNeverWritesUpstream(result.decisions);
  });

  it('never forgets on an untrusted pass', () => {
    // `forget` is gated like every other absence-based decision. Acting on it drops
    // the only record that the file existed.
    const result = plan({ base: [base('a.txt')], trustAbsences: false });
    expect(kinds(result.decisions)).toEqual([]);
    expect(result.deferredPaths).toEqual(['a.txt']);
  });
});

describe('pull-only — hashOnAmbiguous is not consulted', () => {
  it('skips the content comparison even when the flag is on', () => {
    // Both sides "new" means neither has a base, so there is nothing to hash against;
    // the remote's authority settles it and the local bytes are preserved either way.
    const ambiguous = buildReplicationPlan({
      mode: 'pull-only',
      local: [localOnly('a.txt')],
      remote: [side('a.txt', { etag: '"remote-v2"' })],
      base: [],
      trustAbsences: true,
      hashOnAmbiguous: true,
      now: NOW,
    });
    expect(kinds(ambiguous.decisions)).toEqual(['pull-and-preserve a.txt']);
    assertNeverWritesUpstream(ambiguous.decisions);
  });
});

describe('pull-only — every shape, exhaustively', () => {
  it('never emits an upstream write across the full state matrix', () => {
    // The sweep that would catch a branch someone adds later. Each path is run
    // through all eight presence combinations (local × remote × base) with and
    // without `mirrorDeletions`, and every resulting plan is checked against the
    // invariant rather than against an expected list — so a new decision kind has to
    // be classified here to pass, which is the point.
    const variants: PlanSide[] = [side('f.txt'), localOnly('f.txt'), collection('f.txt')];
    const bases: Array<PlanBase | undefined> = [undefined, base('f.txt'), base('f.txt', { remoteEtag: '"f.txt-v0"', remoteMtime: 900 })];

    const offenders: string[] = [];
    for (const local of [undefined, ...variants]) {
      for (const remote of [undefined, ...variants]) {
        for (const b of bases) {
          for (const mirrorDeletions of [false, true]) {
            for (const trustAbsences of [true, false]) {
              const result = buildReplicationPlan({
                mode: 'pull-only',
                local: local === undefined ? [] : [local],
                remote: remote === undefined ? [] : [remote],
                base: b === undefined ? [] : [b],
                trustAbsences,
                mirrorDeletions,
                now: NOW,
              });
              for (const decision of result.decisions) {
                if (decision.kind === 'push' || decision.kind === 'delete-remote' || decision.kind === 'keep-both' || decision.kind === 'compare-content') {
                  offenders.push(`${decision.kind} ${decision.path} (mirror=${mirrorDeletions} trust=${trustAbsences})`);
                }
              }
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('conflictWinner — the two one-way modes', () => {
  it('decides by authority, not by the clock', () => {
    const a = side('a.txt', { mtime: 5000 });
    const b = side('a.txt', { mtime: 1000 });
    // `sync` reads the clock; the one-way modes do not.
    expect(conflictWinner(a, b, 'sync')).toBe('local');
    expect(conflictWinner(a, b, 'copy-only')).toBe('local');
    expect(conflictWinner(a, b, 'pull-only')).toBe('remote');
  });

  it('never returns null for pull-only, so keep-both is unreachable', () => {
    // Identical timestamps are the case `sync` cannot decide. `pull-only` decides
    // anyway: there is no tie to fall back from when one side is the authority.
    const same = side('a.txt', { mtime: 1000 });
    expect(conflictWinner(same, same, 'sync')).toBeNull();
    expect(conflictWinner(same, same, 'pull-only')).toBe('remote');
  });

  it('still returns null for keep-both on a tie', () => {
    const same = side('a.txt', { mtime: 1000 });
    expect(conflictWinner(same, same, 'keep-both')).toBeNull();
  });
});

describe('the other modes are unchanged by pull-only', () => {
  it('still pushes local-only files in every other mode', () => {
    for (const mode of ['keep-both', 'sync', 'copy-only'] as const) {
      const result = buildReplicationPlan({ mode, local: [side('a.txt')], remote: [], base: [], trustAbsences: true });
      expect(kinds(result.decisions)).toEqual(['push a.txt']);
    }
  });

  it('still propagates a local deletion upward in the other modes', () => {
    for (const mode of ['keep-both', 'sync', 'copy-only'] as const) {
      const result = buildReplicationPlan({ mode, local: [], remote: [side('a.txt')], base: [base('a.txt')], trustAbsences: true });
      expect(kinds(result.decisions)).toEqual(['delete-remote a.txt']);
    }
  });

  it('ignores mirrorDeletions outside pull-only', () => {
    // The runner only reads the flag for `pull-only`, and the service refuses to
    // store it anywhere else. This is the belt to that braces: even if a row somehow
    // carries it, a `sync` plan is unchanged.
    const withoutFlag = buildReplicationPlan({
      mode: 'sync',
      local: [side('a.txt')],
      remote: [],
      base: [base('a.txt')],
      trustAbsences: true,
    });
    const withFlag = buildReplicationPlan({
      mode: 'sync',
      local: [side('a.txt')],
      remote: [],
      base: [base('a.txt')],
      trustAbsences: true,
      mirrorDeletions: true,
    });
    expect(kinds(withFlag.decisions)).toEqual(kinds(withoutFlag.decisions));
  });
});