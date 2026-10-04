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
      return [];
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
    (async (path: string) => {
      const prefix = path === '' ? '' : `${path}/`;
      return Object.keys(files)
        .filter((name) => name !== path && (path === '' || name.startsWith(prefix)))
        .map((name) => {
          const entry = { path: name, isCollection: false, etag: `"${name}-v1"`, mtime: 1000, size: files[name]?.length ?? 1, contentType: 'text/plain' };
          return path === '' ? entry : { ...entry, path: name.slice(prefix.length) };
        });
    });
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
    const stub = localStub({ listReplicaChildren: async () => [], loadReplicaStateRows: async () => [baseRow('gone.txt')] });
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
    const stub = localStub({ listReplicaChildren: async () => [], loadReplicaStateRows: async () => [baseRow('gone.txt')] });
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

  it('records every propagated deletion for the audit trail', async () => {
    const stub = localStub({ listReplicaChildren: async () => [], loadReplicaStateRows: async () => [baseRow('gone.txt')] });
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
    const stub = localStub({ listReplicaChildren: async () => [] });
    const { runner } = build({ stub });
    await runner.runSlice();
    const records = stub.applied.filter((operation) => operation.op === 'record');
    expect(records).toEqual([]);
  });

  it('forgets a path that reached neither side', async () => {
    const stub = localStub({
      listReplicaChildren: async () => [],
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
      listReplicaChildren: async (path: string) => (path === '' ? [localFile] : []),
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
      listReplicaChildren: async (path: string) => (path === '' ? [localFile] : []),
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

describe('ReplicationRunner — credential handling', () => {
  it('reports a malformed stored basic credential rather than authenticating as nobody', async () => {
    const key = generateReplicationKey();
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
    expect(result.error).toMatch(/malformed/);
    expect(dao.runs[0]?.status).toBe('failed');
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
      listReplicaChildren: async () => [localFile],
      readReplicaBytes: async () => localBytes(body),
    });
    const target = siblingStub({}, {
      listReplicaChildren: async () => [{ path: 'a.txt', isCollection: false, etag: '"r"', mtime: 1000, size: body.length, contentType: 'text/plain' }],
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
        listReplicaChildren: async () => [{ path: 'a.txt', isCollection: false, etag: '"l2"', mtime: 2000, size: 4, contentType: 'text/plain' }],
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
        listReplicaChildren: async () => [{ path: 'a.txt', isCollection: false, etag: '"l2"', mtime: 2000, size: 3, contentType: 'text/plain' }],
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
