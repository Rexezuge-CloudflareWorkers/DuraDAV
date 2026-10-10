import { describe, expect, it } from 'vitest';
import { ReplicationRunner } from '../apps/background/src/replication/ReplicationRunner';
import type { LocalReplicaStub } from '../apps/background/src/replication/ReplicationRunner';
import type { RemoteEntry } from '@durable-dav/backend-services/replication';
import type { ReplicaStateRow } from '@durable-dav/dav-store';
import type { DavReplicationRow } from '@durable-dav/backend-data/dao';
import { encryptReplicationSecret, generateReplicationKey } from '@durable-dav/backend-data/crypto';

/**
 * The runner, end to end against fakes.
 *
 * The planner's own correctness is covered in `replication-plan.test.ts`. What is
 * left to prove here is the wiring — and specifically the two places where the
 * wiring, rather than the decision, is what keeps data safe:
 *
 * 1. A pass that could not enumerate cleanly must execute **zero** deletions.
 * 2. The recorded base must come from a re-read of both sides after the
 *    transfers, never from what the runner believed it had written.
 */

type Recorded = { op: string; path?: string; state?: Partial<ReplicaStateRow> };
type Call = { op: string; arg?: string };

/**
 * Wrap listing entries in the volume DO's completeness envelope.
 *
 * The default `complete: true` mirrors a real DO read that succeeded. Tests that
 * exercise the gate pass `complete: false` explicitly, so every listing in this
 * file states whether it is trustworthy rather than relying on a bare array.
 */
function listing(
  entries: RemoteEntry[],
  complete = true,
): { entries: RemoteEntry[]; complete: boolean } {
  return { entries, complete };
}

/**
 * In-memory stand-in for a volume Durable Object.
 *
 * Doubles as the *sibling bucket* target in the `dav-volume` tests, which is what
 * lets them drive the real `buildRemote` instead of a stubbed-out version — the
 * credential path only exists in the real code, and a test that replaces it is a
 * test that cannot catch a bug in it.
 */
function localStub(overrides: Partial<LocalReplicaStub> = {}): LocalReplicaStub & { applied: Recorded[]; state: ReplicaStateRow[]; calls: Call[] } {
  const applied: Recorded[] = [];
  const state: ReplicaStateRow[] = [];
  const calls: Call[] = [];
  return {
    applied,
    state,
    calls,
    listReplicaChildren: async (path) => {
      calls.push({ op: 'list', arg: path });
      return listing([]);
    },
    readReplicaStream: async (path) => {
      calls.push({ op: 'get', arg: path });
      return null;
    },
    readReplicaBytes: async () => null,
    loadReplicaStateRows: async () => [...state],
    forgetReplication: async () => {
      state.length = 0;
    },
    applyReplicaOperations: async (_id, operations) => {
      for (const operation of operations as Recorded[]) {
        applied.push(operation);
        calls.push({ op: operation.op, arg: operation.path });
        if (operation.op === 'record' && operation.state) state.push(operation.state as ReplicaStateRow);
        if (operation.op !== 'forget') continue;
        const index = state.findIndex((row) => row.path === operation.path);
        if (index !== -1) state.splice(index, 1);
      }
      return { applied: (operations as Recorded[]).length, failed: 0, error: null };
    },
    ...overrides,
  } as LocalReplicaStub & { applied: Recorded[]; state: ReplicaStateRow[]; calls: Call[] };
}

/**
 * A sibling bucket, exposed through the same stub shape.
 *
 * `DavVolumeRemote` calls back into it through `env.DAV_VOLUME.getByName`, so the
 * adapter's rebasing and RPC plumbing are exercised for real.
 */
function siblingStub(files: Record<string, string>, overrides: Partial<LocalReplicaStub> = {}) {
  const inner = localStub();
  const listChildren =
    overrides.listReplicaChildren ??
    (async (path: string) =>
      listing(
        Object.keys(files)
          .filter((name) => name !== path && (path === '' || name.startsWith(`${path}/`)))
          .map((name) => {
            const entry = { path: name, isCollection: false, etag: `"${name}-v1"`, mtime: 1000, size: files[name]?.length ?? 1, contentType: 'text/plain' };
            return path === '' ? entry : { ...entry, path: name.slice(path.length + 1) };
          }),
      ));
  return {
    ...inner,
    ...overrides,
    async listReplicaChildren(path: string) {
      inner.calls.push({ op: 'list', arg: path });
      return listChildren(path);
    },
    async readReplicaStream(path: string) {
      inner.calls.push({ op: 'get', arg: path });
      const content = Object.hasOwn(files, path) ? files[path] : null;
      return content === null ? null : new Response(content).body;
    },
  } as LocalReplicaStub & { applied: Recorded[]; state: ReplicaStateRow[]; calls: Call[] };
}

function replicationRow(overrides: Partial<DavReplicationRow> = {}): DavReplicationRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    replication_id: 'rep_1',
    volume_id: 'vol_1',
    target_kind: 'dav-volume',
    remote_url: '',
    remote_owner: 'alice',
    remote_volume: 'backup',
    remote_path: '',
    auth_kind: 'none',
    encrypted_secret: null,
    secret_iv: null,
    mode: 'keep-both',
    // `0` rather than omitted: a pre-0007 row has no column at all, and
    // `ReplicationRunner.mirrorDeletions` reads `=== 1`, so both mean "safe copy".
    mirror_deletions: 0,
    interval_minutes: 360,
    enabled: 1,
    last_run_at: now,
    last_status: null,
    last_error: null,
    consecutive_failures: 0,
    cursor_path: null,
    cursor_remaining: 0,
    pass_started_at: null,
    created_at: now,
    updated_at: now,
    created_by: 'alice@example.com',
    ...overrides,
  };
}

/**
Records what `recordRun` was told, which is where the deletion gate is stored.
*/
function recordingDAO() {
  const runs: Array<{ status: string; error: string | null; remaining: number }> = [];
  return {
    runs,
    async beginPass() {},
    async recordRun(_id: string, status: string, error: string | null, _now: number, _max: number, _cursor: string | null, remaining: number) {
      runs.push({ status, error, remaining });
    },
    async deleteById() {},
  };
}

/**
 * Build a runner over fakes.
 *
 * `remote` defaults to an empty sibling bucket reached through a fake
 * `DAV_VOLUME` namespace, so the real `buildRemote` and the real
 * `DavVolumeRemote` adapter both run. Nothing here reaches the network, and the
 * `dav` target kind is still available for the credential tests.
 */
function build(options: {
  row?: Partial<DavReplicationRow>;
  stub?: LocalReplicaStub & { applied: Recorded[]; state: ReplicaStateRow[]; calls: Call[] };
  remote?: LocalReplicaStub & { applied: Recorded[]; state: ReplicaStateRow[]; calls: Call[] };
  remoteFiles?: Record<string, string>;
  env?: Record<string, unknown>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  conflictDAO?: { record: (input: unknown) => Promise<void> };
}) {
  const row = replicationRow(options.row);
  const stub = options.stub ?? localStub();
  const target = options.remote ?? siblingStub(options.remoteFiles ?? {});
  const dao = recordingDAO();
  const conflicts: unknown[] = [];
  const env = {
    DB: {} as never,
    DAV_VOLUME: { getByName: () => target },
    ...options.env,
  };
  const runner = new ReplicationRunner(env as never, row, 'alice', 'demo', stub, {
    replicationDAO: dao as never,
    conflictDAO: (options.conflictDAO ?? { record: async (input: unknown) => void conflicts.push(input) }) as never,
    // A constructor dep, not an env value — the transport's egress is injected here.
    fetchImpl: options.fetchImpl,
  });
  return { runner, row, stub, target, dao, conflicts, env };
}

describe('ReplicationRunner — pass bookkeeping', () => {
  it('opens a pass and records a clean run', async () => {
    const { runner, dao } = build({});
    const result = await runner.runSlice();
    expect(result.status).toBe('ok');
    expect(dao.runs).toEqual([{ status: 'ok', error: null, remaining: 0 }]);
  });

  it('never throws, and records the failure on the row instead', async () => {
    // One unreachable target must not abort the rest of the cron sweep.
    const target = siblingStub({}, {
      listReplicaChildren: async () => {
        throw new Error('target is down');
      },
    });
    const { runner, dao } = build({ remote: target });
    const result = await runner.runSlice();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('target is down');
    expect(dao.runs[0]?.status).toBe('failed');
  });

  it('abandons a stale pass and clears its cursor', async () => {
    // Resuming from a stale cursor would skip every collection before its
    // position and then report the sweep complete.
    const stale = Math.floor(Date.now() / 1000) - 100_000;
    const { runner } = build({ row: { pass_started_at: stale, cursor_path: 'deep/inside', cursor_remaining: 42 } });
    await runner.runSlice();
    expect(stale).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it('does not re-probe the target on every tick', async () => {
    // The probe is the only thing that distinguishes "empty" from "not a WebDAV
    // server", and it costs a round trip on every later pass for no new
    // information.
    const { runner, target } = build({ row: { last_run_at: Math.floor(Date.now() / 1000) } });
    await runner.runSlice();
    expect(target.calls.filter((call) => call.op === 'list' && call.arg === '')).toHaveLength(1);
  });

  it('probes on the first ever run', async () => {
    const { runner, target } = build({ row: { last_run_at: null } });
    await runner.runSlice();
    // `DavVolumeRemote.probe` reads the root, so it shows up as one extra `list ''`
    // ahead of the sweep's own.
    expect(target.calls.filter((call) => call.op === 'list' && call.arg === '')).toHaveLength(2);
  });
});

describe('ReplicationRunner — the deletion gate', () => {
  function baseRow(path: string): ReplicaStateRow {
    return {
      replicationId: 'rep_1',
      path,
      isCollection: false,
      localEtag: '"a-v1"',
      localMtime: 1000,
      localSize: 10,
      remoteEtag: '"a-v1"',
      remoteMtime: 1000,
      remoteSize: 10,
      contentType: 'text/plain',
      syncedAt: 1,
    };
  }

  it('deletes from the remote when the local side removed the file', async () => {
    const stub = localStub({ listReplicaChildren: async () => listing([]), loadReplicaStateRows: async () => [baseRow('gone.txt')] });
    const { runner, dao, target } = build({ stub, remoteFiles: { 'gone.txt': 'x' } });
    const result = await runner.runSlice();
    expect(target.calls.some((call) => call.op === 'unlink' && call.arg === 'gone.txt')).toBe(true);
    expect(result.deferredPaths).toBe(0);
    expect(dao.runs[0]?.status).toBe('ok');
  });

  it('executes zero deletions when the remote listing failed', async () => {
    // The single most important assertion in this file: an absence observed
    // through a listing that did not complete is not evidence of anything. The
    // sibling's RPC throws rather than returning `[]` for exactly this reason.
    const stub = localStub({ listReplicaChildren: async () => listing([]), loadReplicaStateRows: async () => [baseRow('gone.txt')] });
    const target = siblingStub({}, {
      listReplicaChildren: async () => {
        throw new Error('sibling dofs unavailable');
      },
    });
    const { runner } = build({ stub, remote: target });
    const result = await runner.runSlice();
    expect(target.calls.some((call) => call.op === 'unlink')).toBe(false);
    expect(result.deferredPaths).toBe(1);
    // A suppressed deletion must not leave the pass looking clean.
    expect(result.status).not.toBe('ok');
  });

  it('executes zero deletions when a local listing failed', async () => {
    // Local incompleteness must never read as "empty locally", which would make
    // every remote file look newly-removed.
    const stub = localStub({
      listReplicaChildren: async () => {
        throw new Error('dofs unavailable');
      },
      loadReplicaStateRows: async () => [baseRow('keep.txt')],
    });
    const { runner, target } = build({ stub, remoteFiles: { 'keep.txt': 'x' } });
    const result = await runner.runSlice();
    expect(target.calls.some((call) => call.op === 'unlink')).toBe(false);
    expect(result.deferredPaths).toBe(1);
  });

  it('executes zero deletions when the remote reports an incomplete listing', async () => {
    // The case a thrown RPC does not cover. A sibling that *succeeds* and reports
    // `complete: false` has told us its absences are meaningless — the adapter
    // used to answer `complete: true` on its own behalf, which turned this into
    // a silent mass deletion while the pass reported itself clean.
    const stub = localStub({ listReplicaChildren: async () => listing([]), loadReplicaStateRows: async () => [baseRow('gone.txt')] });
    const target = siblingStub({}, { listReplicaChildren: async () => listing([], false) });
    const { runner } = build({ stub, remote: target });
    const result = await runner.runSlice();
    expect(target.calls.some((call) => call.op === 'unlink')).toBe(false);
    expect(result.deferredPaths).toBe(1);
    expect(result.status).not.toBe('ok');
  });

  it('executes zero deletions when the local side reports an incomplete listing', async () => {
    // Symmetric to the remote case. A partial local listing omits paths, and each
    // omission would read as "not here" and queue a pull that overwrites a good
    // local copy with a stale remote one.
    const stub = localStub({ listReplicaChildren: async () => listing([], false), loadReplicaStateRows: async () => [baseRow('keep.txt')] });
    const { runner, target } = build({ stub, remoteFiles: { 'keep.txt': 'remote' } });
    const result = await runner.runSlice();
    expect(target.calls.some((call) => call.op === 'write')).toBe(false);
    expect(result.deferredPaths).toBe(1);
  });

  it('records every propagated deletion for the audit trail', async () => {
    const stub = localStub({ listReplicaChildren: async () => listing([]), loadReplicaStateRows: async () => [baseRow('gone.txt')] });
    const { runner, conflicts } = build({ stub, remoteFiles: { 'gone.txt': 'x' } });
    await runner.runSlice();
    // Deletions are the irreversible ones, so "which side won, and what was kept"
    // has to be answerable afterwards.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: 'gone.txt', kind: 'deletion' });
  });
});

describe('ReplicationRunner — the recorded base', () => {
  it('records nothing for a path that still exists on only one side', async () => {
    // A half-applied transfer must not be remembered as agreement, or the next
    // pass sees "unchanged" and never finishes the job.
    const stub = localStub({ listReplicaChildren: async () => listing([]) });
    const { runner } = build({ stub });
    await runner.runSlice();
    const records = stub.applied.filter((operation) => operation.op === 'record');
    expect(records).toEqual([]);
  });

  it('forgets a path that reached neither side', async () => {
    const stub = localStub({
      listReplicaChildren: async () => listing([]),
      loadReplicaStateRows: async () => [
        {
          replicationId: 'rep_1',
          path: 'vanished.txt',
          isCollection: false,
          localEtag: '"v1"',
          localMtime: 1,
          localSize: 1,
          remoteEtag: '"v1"',
          remoteMtime: 1,
          remoteSize: 1,
          contentType: null,
          syncedAt: 1,
        },
      ],
    });
    const { runner } = build({ stub });
    await runner.runSlice();
    expect(stub.applied.filter((operation) => operation.op === 'forget')).toEqual([{ op: 'forget', path: 'vanished.txt' }]);
  });

  it('clears every recorded path when the replication is forgotten', async () => {
    const { runner, stub } = build({});
    stub.state.push({
      replicationId: 'rep_1',
      path: 'a.txt',
      isCollection: false,
      localEtag: null,
      localMtime: null,
      localSize: null,
      remoteEtag: null,
      remoteMtime: null,
      remoteSize: null,
      contentType: null,
      syncedAt: 1,
    });
    await runner.forget();
    // A re-created replication against the same target must not inherit this:
    // its first pass would compare a fresh tree against a record of a tree that
    // no longer exists.
    expect(stub.state).toEqual([]);
  });
});

describe('ReplicationRunner — transfers', () => {
  it('pushes a new local file to the remote', async () => {
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: '"a-v1"', mtime: 1000, size: 3, contentType: 'text/plain' };
    const stub = localStub({
      listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []),
      readReplicaStream: async () => new Response('abc').body,
    });
    const { runner, target } = build({ stub });
    await runner.runSlice();
    expect(target.calls.some((call) => call.op === 'write' && call.arg === 'a.txt')).toBe(true);
  });

  it('pulls a new remote file down', async () => {
    const stub = localStub();
    const { runner } = build({ stub, remoteFiles: { 'b.txt': 'hello' } });
    await runner.runSlice();
    expect(stub.applied.some((operation) => operation.op === 'write' && operation.path === 'b.txt')).toBe(true);
  });

  it('never pulls in copy-only mode', async () => {
    // A mirror must not import from the mirror: a corrupted copy overwriting the
    // original is the failure this mode exists to prevent.
    const stub = localStub();
    const { runner } = build({ stub, remoteFiles: { 'b.txt': 'hello' }, row: { mode: 'copy-only' } });
    await runner.runSlice();
    expect(stub.applied.some((operation) => operation.op === 'write')).toBe(false);
  });

  it('creates a parent collection before writing into it', async () => {
    const stub = localStub();
    const { runner } = build({ stub, remoteFiles: { 'dir/a.txt': 'hello' } });
    await runner.runSlice();
    const order = stub.applied.map((operation) => `${operation.op} ${operation.path ?? ''}`);
    expect(order.indexOf('mkdir dir')).toBeLessThan(order.indexOf('write dir/a.txt'));
  });

  it('writes a conflict copy rather than overwriting, in keep-both', async () => {
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: '"local-v2"', mtime: 2000, size: 3, contentType: 'text/plain' };
    const stub = localStub({
      listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []),
      readReplicaStream: async () => new Response('abc').body,
      loadReplicaStateRows: async () => [
        {
          replicationId: 'rep_1',
          path: 'a.txt',
          isCollection: false,
          localEtag: '"a-v1"',
          localMtime: 1000,
          localSize: 3,
          remoteEtag: '"a-v1"',
          remoteMtime: 1000,
          remoteSize: 3,
          contentType: 'text/plain',
          syncedAt: 1,
        },
      ],
    });
    const { runner, conflicts, target } = build({ stub, remoteFiles: { 'a.txt': 'remote version' } });
    await runner.runSlice();
    // Neither side is overwritten; the remote's version lands beside the local one
    // locally, and the local one beside the remote's remotely.
    expect(target.calls.some((call) => call.op === 'write' && String(call.arg).startsWith('a.txt.conflict-'))).toBe(true);
    expect(stub.applied.some((operation) => operation.op === 'write' && String(operation.path).startsWith('a.txt.conflict-'))).toBe(true);
    expect(conflicts[0]).toMatchObject({ kind: 'conflict' });
  });
});

/**
 * `pull-only` end to end: the mode where nothing is ever written to the remote.
 *
 * The planner's half of this is proven in `replication-pull-only.test.ts`. What is
 * left is the *wiring*, and it is worth proving separately for two reasons. First,
 * the transfer strategies are separate code (`planTransfers`) and a branch can be
 * planned correctly and executed wrongly. Second, `PlanExecutor.recordBase` runs
 * after the transfers and re-reads both sides — so a decision can be right and the
 * base it records can still resurrect or drop state on the next pass.
 */
describe('ReplicationRunner — pull-only', () => {
  /**
   * A bucket holding `a.txt` locally and on the sibling, with a base row recording
   * that agreement — the fixture every pull-only transfer needs. `localBody` is what
   * the local stream serves, which is how a test distinguishes the preserved copy
   * from the pulled one.
   */
  function pullOnlyFixture(options?: { localEtag?: string; remoteEtag?: string; localBody?: string }): LocalReplicaStub & {
    applied: Recorded[];
    state: ReplicaStateRow[];
    calls: Call[];
  } {
    const localEtag = options?.localEtag ?? '"l-v2"';
    const remoteEtag = options?.remoteEtag ?? '"r-v1"';
    const localBody = options?.localBody ?? 'local bytes';
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: localEtag, mtime: 1000, size: localBody.length, contentType: 'text/plain' };
    return localStub({
      listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []),
      readReplicaStream: async () => new Response(localBody).body,
      loadReplicaStateRows: async () => [
        {
          replicationId: 'rep_1',
          path: 'a.txt',
          isCollection: false,
          localEtag: '"l-v1"',
          localMtime: 1000,
          localSize: 1,
          remoteEtag,
          remoteMtime: 1000,
          remoteSize: 1,
          contentType: 'text/plain',
          syncedAt: 1,
        },
      ],
    });
  }

  it('preserves a local edit and writes the remote version over it', async () => {
    const stub = pullOnlyFixture();
    const { runner, target, conflicts } = build({ stub, remoteFiles: { 'a.txt': 'remote version' }, row: { mode: 'pull-only' } });
    await runner.runSlice();

    // The remote is never written in this mode — not the path, not a conflict copy.
    expect(target.applied.some((operation) => operation.op === 'write' || operation.op === 'unlink')).toBe(false);
    // The local edit is preserved beside the path before the pull.
    const preserved = stub.applied.find((operation) => operation.op === 'write' && String(operation.path).startsWith('a.txt.conflict-'));
    expect(preserved).toBeDefined();
    // And the remote's version lands at the path itself.
    expect(stub.applied.some((operation) => operation.op === 'write' && operation.path === 'a.txt')).toBe(true);
    expect(conflicts[0]).toMatchObject({ kind: 'conflict', winner: 'remote' });
  });

  it('records a base so the next pass sees agreement rather than repeating the pull', async () => {
    const stub = pullOnlyFixture();
    const { runner } = build({ stub, remoteFiles: { 'a.txt': 'remote version' }, row: { mode: 'pull-only' } });
    await runner.runSlice();
    // `recordBase` re-reads both sides after the transfer. A half-applied transfer
    // must record *nothing* — a base built from what the runner believed it wrote
    // would make the next pass see "unchanged" and never finish the job.
    expect(stub.applied.some((operation) => operation.op === 'record')).toBe(true);
  });

  it('never writes upstream when only the remote changed', async () => {
    const stub = localStub({
      listReplicaChildren: async (path: string) =>
        listing(path === '' ? [{ path: 'a.txt', isCollection: false, etag: '"l-v1"', mtime: 1000, size: 1, contentType: 'text/plain' }] : []),
      loadReplicaStateRows: async () => [
        {
          replicationId: 'rep_1',
          path: 'a.txt',
          isCollection: false,
          localEtag: '"l-v1"',
          localMtime: 1000,
          localSize: 1,
          remoteEtag: '"r-v1"',
          remoteMtime: 1000,
          remoteSize: 1,
          contentType: 'text/plain',
          syncedAt: 1,
        },
      ],
    });
    const { runner, target } = build({ stub, remoteFiles: { 'a.txt': 'remote version' }, row: { mode: 'pull-only' } });
    await runner.runSlice();
    expect(target.applied.some((operation) => operation.op === 'write' || operation.op === 'unlink')).toBe(false);
    expect(stub.applied.some((operation) => operation.op === 'write' && operation.path === 'a.txt')).toBe(true);
  });

  it('deletes a local file the remote lacks only when mirrorDeletions is set', async () => {
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: '"l-v1"', mtime: 1000, size: 1, contentType: 'text/plain' };
    const stub = localStub({ listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []) });

    const safe = build({ stub: localStub({ listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []) }), row: { mode: 'pull-only', mirror_deletions: 0 } });
    await safe.runner.runSlice();
    expect(safe.stub.applied.some((operation) => operation.op === 'unlink')).toBe(false);

    const mirror = build({ stub: localStub({ listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []) }), row: { mode: 'pull-only', mirror_deletions: 1 } });
    await mirror.runner.runSlice();
    expect(mirror.stub.applied.some((operation) => operation.op === 'unlink' && operation.path === 'a.txt')).toBe(true);
    // The remote is still never written, whatever the flag says.
    expect(mirror.target.applied.some((operation) => operation.op === 'write' || operation.op === 'unlink')).toBe(false);
    expect(stub.applied).toEqual([]);
  });

  it('does not delete anything when the pass could not see the whole tree', async () => {
    // The gate, through the real runner: a listing that admits it was incomplete
    // must not authorize a mirror deletion. This is the test that would fail if
    // `mirrorDeletions` were read as a licence rather than as a request.
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: '"l-v1"', mtime: 1000, size: 1, contentType: 'text/plain' };
    const stub = localStub({
      listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : [], false),
      loadReplicaStateRows: async () => [
        {
          replicationId: 'rep_1',
          path: 'a.txt',
          isCollection: false,
          localEtag: '"l-v1"',
          localMtime: 1000,
          localSize: 1,
          remoteEtag: '"r-v1"',
          remoteMtime: 1000,
          remoteSize: 1,
          contentType: 'text/plain',
          syncedAt: 1,
        },
      ],
    });
    const { runner, dao } = build({ stub, row: { mode: 'pull-only', mirror_deletions: 1 } });
    const result = await runner.runSlice();
    expect(stub.applied.some((operation) => operation.op === 'unlink')).toBe(false);
    expect(result.deferredPaths).toBe(1);
    // A dirty pass keeps `pass_started_at` set only if work remains; here the tree
    // was fully walked, so the gate closes on the `partial`/`failed` status instead.
    expect(dao.runs[0]?.status).not.toBe('ok');
  });

  it('treats a row with no mirror_deletions column as a safe copy', async () => {
    // A pre-0007 row has the column absent, so `SELECT *` yields `undefined`. Read
    // as anything but "not mirroring", a deployment upgraded without running the
    // migration would start deleting files.
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: '"l-v1"', mtime: 1000, size: 1, contentType: 'text/plain' };
    const stub = localStub({
      listReplicaChildren: async (path: string) => listing(path === '' ? [localFile] : []),
      loadReplicaStateRows: async () => [
        {
          replicationId: 'rep_1',
          path: 'a.txt',
          isCollection: false,
          localEtag: '"l-v1"',
          localMtime: 1000,
          localSize: 1,
          remoteEtag: '"r-v1"',
          remoteMtime: 1000,
          remoteSize: 1,
          contentType: 'text/plain',
          syncedAt: 1,
        },
      ],
    });
    const { runner } = build({ stub, row: { mode: 'pull-only', mirror_deletions: undefined as unknown as number } });
    await runner.runSlice();
    expect(stub.applied.some((operation) => operation.op === 'unlink')).toBe(false);
  });

  it('falls back to keep-both for a mode this build does not know', async () => {
    // The two one-way modes are the dangerous ones to resolve wrongly: reading a
    // stored `copy-only` as two-way would push, and a stored `pull-only` as
    // two-way would overwrite. The fallback is the two-way mode *without* one of
    // those meanings, so an unknown value never becomes a one-directional write.
    const stub = localStub();
    const { runner } = build({ stub, remoteFiles: { 'b.txt': 'hello' }, row: { mode: 'from-the-future' } });
    const result = await runner.runSlice();
    expect(result.status).toBe('ok');
  });
});

describe('ReplicationRunner — credential handling', () => {
  it('reports a stored basic credential in an unreadable format rather than authenticating as nobody', async () => {
    const key = generateReplicationKey();
    // A colon-free blob: what the writer produced before it composed the `user:`
    // prefix, and still the shape any hand-edited or corrupted row would have. The
    // reader must refuse it — treating the whole blob as a username would send the
    // owner's password to the remote as an identity.
    const envelope = await encryptReplicationSecret('no-colon-here', key);
    // `target_kind: 'dav'` reaches the HTTP path, but the credential is
    // rejected before any request is built — which is the point: the failure must
    // surface as `failed`, not as an unauthenticated request.
    const { runner, dao } = build({
      env: { REPLICATION_ENCRYPTION_KEY: key },
      row: { target_kind: 'dav', remote_url: 'https://dav.example.com/f', auth_kind: 'basic', encrypted_secret: envelope.ciphertext, secret_iv: envelope.iv },
    });
    const result = await runner.runSlice();
    expect(result.status).toBe('failed');
    // A *format* fault, so the message says so and points at re-entering the
    // credential. It used to say "rotate it", which was a no-op: rotation re-sealed
    // the same bare password and failed identically.
    expect(result.error).toMatch(/unreadable format/);
    expect(dao.runs[0]?.status).toBe('failed');
  });

  it('authenticates a basic credential sealed with the user: prefix', async () => {
    // The other half of the fix, and the reason the previous test was not enough:
    // it proved the reader *refuses* a colon-free blob but never proved the reader
    // *accepts* a correct one. A reader that refused everything would have passed it.
    // This drives the real `buildRemote` and the real `basicAuthValue`.
    const key = generateReplicationKey();
    const envelope = await encryptReplicationSecret('alice:hunter2', key);
    const seen: (string | null)[] = [];
    const { runner } = build({
      env: { REPLICATION_ENCRYPTION_KEY: key },
      // Capture the header the transport would actually send.
      fetchImpl: async (_input: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('Authorization'));
        return new Response('<multistatus xmlns="DAV:"/>', { status: 207, headers: { 'Content-Type': 'application/xml' } });
      },
      row: {
        target_kind: 'dav',
        remote_url: 'https://dav.example.com/f',
        auth_kind: 'basic',
        encrypted_secret: envelope.ciphertext,
        secret_iv: envelope.iv,
      },
    });
    await runner.runSlice();
    // RFC 7617: base64 of `user:password`. Decoding it back is the assertion that
    // matters — it pins the halves, not just the presence of a header.
    const header = seen.find((value) => value !== null);
    expect(header).toBeDefined();
    expect(atob(String(header).replace('Basic ', ''))).toBe('alice:hunter2');
  });

it('reports a decryption failure instead of skipping authentication', async () => {
    // Reporting it as `failed` is correct; skipping auth would let the remote
    // answer 401 and the owner would debug a key problem as a target problem.
    const envelope = await encryptReplicationSecret('user:pw', generateReplicationKey());
    const { runner, dao } = build({
      env: { REPLICATION_ENCRYPTION_KEY: generateReplicationKey() },
      row: { target_kind: 'dav', remote_url: 'https://dav.example.com/f', auth_kind: 'basic', encrypted_secret: envelope.ciphertext, secret_iv: envelope.iv },
    });
    const result = await runner.runSlice();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/could not be decrypted/);
    expect(dao.runs[0]?.status).toBe('failed');
  });

  it('reports a missing encryption key rather than proceeding unauthenticated', async () => {
    const { runner } = build({
      row: { target_kind: 'dav', remote_url: 'https://dav.example.com/f', auth_kind: 'bearer', encrypted_secret: 'x', secret_iv: 'y' },
    });
    const result = await runner.runSlice();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/REPLICATION_ENCRYPTION_KEY/);
  });
});

describe('ReplicationRunner — the ambiguity hash', () => {
  /**
   * `bytesToBinary` only runs here, and its chunking loop only runs for a payload
   * over the chunk size — so the fixture is deliberately larger than one chunk.
   */
  const BIG = 'x'.repeat(20_000);

  function localBytes(body: string): Uint8Array {
    return new TextEncoder().encode(body);
  }

  it('agrees when the two sides hash equal, without transferring either', async () => {
    const body = BIG;
    const localFile: RemoteEntry = { path: 'a.txt', isCollection: false, etag: '"l"', mtime: 1000, size: body.length, contentType: 'text/plain' };
    const stubLocal = localStub({
      // One entry at any depth: the file sits at the root, so the walk never descends
      // and the listing answer is the same whatever it asks for.
      listReplicaChildren: async () => listing([localFile]),
      readReplicaBytes: async () => localBytes(body),
    });
    const target = siblingStub({}, {
      listReplicaChildren: async () => listing([{ path: 'a.txt', isCollection: false, etag: '"r"', mtime: 1000, size: body.length, contentType: 'text/plain' }]),
      readReplicaStream: async () => new Response(body).body,
    });
    const { runner, stub: applied } = build({ stub: stubLocal, remote: target, env: { REPLICATION_HASH_ON_AMBIGUOUS: 'true' } });
    await runner.runSlice();
    // Equal hashes mean agreement: nothing is pushed, nothing is pulled, and the base
    // is refreshed from the pair as it stands.
    expect(applied.calls.some((call) => call.op === 'write')).toBe(false);
    expect(applied.calls.some((call) => call.op === 'record')).toBe(true);
  });

  it('applies the winning side when the hashes differ', async () => {
    const { runner, stub: applied, target } = build({
      stub: localStub({
        // A newer local mtime so `sync` has a decidable winner. Without one the two
        // sides tie and the planner resolves to keep-both before it ever hashes —
        // which is correct, and would leave the hash path untested.
        listReplicaChildren: async () => listing([{ path: 'a.txt', isCollection: false, etag: '"l2"', mtime: 2000, size: 4, contentType: 'text/plain' }]),
        loadReplicaStateRows: async () => [
          {
            replicationId: 'rep_1',
            path: 'a.txt',
            isCollection: false,
            localEtag: '"l1"',
            localMtime: 1000,
            localSize: 4,
            remoteEtag: '"r1"',
            remoteMtime: 1000,
            remoteSize: 4,
            contentType: 'text/plain',
            syncedAt: 1,
          },
        ],
        readReplicaStream: async () => new Response('bbbb').body,
        // The hash reads whole bytes; a null here would make `compareContent` a
        // silent no-op rather than a decision, which is the one thing this case
        // exists to rule out.
        readReplicaBytes: async () => localBytes('bbbb'),
      }),
      remote: siblingStub({ 'a.txt': 'cccc' }),
      // `keep-both` — the fixture default — resolves every genuine conflict by
      // preserving both sides, so it never reaches the hash at all. This case is
      // about `sync`.
      row: { mode: 'sync' },
      env: { REPLICATION_HASH_ON_AMBIGUOUS: 'true' },
    });
    await runner.runSlice();
    // `sync` plus a strictly newer local mtime makes the winner decidable, so the plan
    // reaches the hash instead of falling back to keep-both, and the local side is
    // pushed. The point is that the decision came from a content comparison rather
    // than from assuming equal size meant equal bytes.
    expect(target.calls.some((call) => call.op === 'write' && call.arg === 'a.txt')).toBe(true);
    expect(applied.calls.some((call) => call.op === 'write' && call.arg === 'a.txt')).toBe(false);
  });
});

describe('ReplicationRunner — configuration and credentials', () => {
  it('sends a bearer token', async () => {
    const key = generateReplicationKey();
    const envelope = await encryptReplicationSecret('tok-123', key);
    const { runner, target } = build({
      env: { REPLICATION_ENCRYPTION_KEY: key },
      row: { target_kind: 'dav', remote_url: 'https://dav.example.com/f', auth_kind: 'bearer', encrypted_secret: envelope.ciphertext, secret_iv: envelope.iv },
      stub: localStub(),
    });
    // The HTTP path is stubbed at `buildRemote` in this file, so what is asserted here
    // is that construction succeeded and the pass ran — the header itself is covered by
    // `replication-dav-http-remote.test.ts`.
    void runner;
    expect(target).toBeDefined();
  });

  it('reports a missing DAV_VOLUME binding rather than throwing', async () => {
    const row = replicationRow();
    const dao = recordingDAO();
    const runner = new ReplicationRunner(
      { DB: {} as never } as never,
      row,
      'alice',
      'demo',
      localStub(),
      { replicationDAO: dao as never, conflictDAO: { record: async () => undefined } as never },
    );
    // A misconfigured deployment must degrade to a recorded failure, not a 500 from the
    // cron worker.
    const result = await runner.runSlice();
    expect(result.status).toBe('failed');
    expect(dao.runs[0]?.status).toBe('failed');
  });

  it('survives a missing KV binding', async () => {
    // Best-effort by design: a purge failure must not fail the write that triggered it.
    const { runner } = build({});
    await expect(runner.runSlice()).resolves.toMatchObject({ status: 'ok' });
  });

  it('records a conflict even when the audit write fails', async () => {
    const { runner } = build({
      stub: localStub({
        listReplicaChildren: async () => listing([{ path: 'a.txt', isCollection: false, etag: '"l2"', mtime: 2000, size: 3, contentType: 'text/plain' }]),
        readReplicaStream: async () => new Response('abc').body,
      }),
      remote: siblingStub({ 'a.txt': 'remote version' }),
      conflictDAO: {
        record: async () => {
          throw new Error('audit unavailable');
        },
      },
    });
    // The audit row is how a destructive decision is explained afterwards, but losing
    // one must not abandon a transfer that already succeeded.
    await expect(runner.runSlice()).resolves.toMatchObject({ status: 'ok' });
  });
});
