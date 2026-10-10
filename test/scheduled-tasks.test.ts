/**
 * The scheduled sweep.
 *
 * Two properties carry the risk here, and both are the kind that fail silently:
 *
 * 1. **Phase ordering.** Replication runs in phase 2, after the credential
 *    prune. A replication that deletes on both sides has no business being the
 *    first thing a tick spends its budget on.
 * 2. **Containment.** One unreachable target must not abort the other buckets in
 *    the same tick. `ReplicationSyncTask` must never throw: a throw here would be
 *    attributed to the *task*, not to the target, and would take the credential
 *    prune down with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// `TaskRegistry` is imported dynamically *after* the mocks above, so the
// factories it captures are the mocked tasks rather than the real ones. A static
// top-level import would be hoisted above `vi.mock` and load the real classes.

const runPrune = vi.fn<() => Promise<void>>();
const runReplication = vi.fn<() => Promise<void>>();

// Mocked before the registry is imported so the factories it captures are these.
vi.mock('../apps/background/src/scheduled/ExpiredCredentialPruningTask', () => ({
  ExpiredCredentialPruningTask: class {
    public readonly name = 'ExpiredCredentialPruningTask';
    public readonly phase = 1 as const;
    public async run(): Promise<void> {
      await runPrune();
    }
  },
}));

vi.mock('../apps/background/src/scheduled/ReplicationSyncTask', () => ({
  ReplicationSyncTask: class {
    public readonly name = 'ReplicationSyncTask';
    public readonly phase = 2 as const;
    public async run(): Promise<void> {
      await runReplication();
    }
  },
}));

const { CRON_TASK_FACTORIES, runScheduledTasks: run, tasksForPhase } = await import('../apps/background/src/scheduled/TaskRegistry');

beforeEach(() => {
  // The mocks are module-level, so their call counts would otherwise accumulate
  // across tests and make "was this invoked once?" answer the wrong question.
  runPrune.mockReset();
  runReplication.mockReset();
  runPrune.mockResolvedValue(undefined);
  runReplication.mockResolvedValue(undefined);
});

describe('task registry', () => {
  it('registers the credential prune in phase 1 and replication in phase 2', () => {
    const names = CRON_TASK_FACTORIES.map((task) => task.name);
    expect(names).toContain('ExpiredCredentialPruningTask');
    expect(names).toContain('ReplicationSyncTask');
    expect(CRON_TASK_FACTORIES.find((t) => t.name === 'ExpiredCredentialPruningTask')?.phase).toBe(1);
    expect(CRON_TASK_FACTORIES.find((t) => t.name === 'ReplicationSyncTask')?.phase).toBe(2);
  });

  it('builds only the requested phase', () => {
    expect(tasksForPhase(1).map((t) => t.name)).toEqual(['ExpiredCredentialPruningTask']);
    expect(tasksForPhase(2).map((t) => t.name)).toEqual(['ReplicationSyncTask']);
  });

  it('adds no cron trigger for replication — it shares the existing sweep', () => {
    // Replication adding a second trigger would give it its own budget, which is
    // what the shared `*/10` budget and the slicing exist to avoid.
    expect(CRON_TASK_FACTORIES).toHaveLength(2);
  });
});

describe('runScheduledTasks', () => {
  it('completes phase 1 before starting phase 2', async () => {
    const order: string[] = [];
    runPrune.mockImplementation(() => {
      order.push('phase1');
      return Promise.resolve();
    });
    runReplication.mockImplementation(() => {
      order.push('phase2');
      return Promise.resolve();
    });

    await run({} as never, '*/10 * * * *', Date.now());
    expect(order).toEqual(['phase1', 'phase2']);
  });

  it('does not let a failing phase-1 task stop phase 2', async () => {
    runPrune.mockRejectedValue(new Error('prune blew up'));
    runReplication.mockResolvedValue(undefined);

    await expect(run({} as never, '*/10 * * * *', Date.now())).resolves.toBeUndefined();
    // The sweep must not abort: the other bucket's replication still runs.
    expect(runReplication).toHaveBeenCalled();
  });

  it('does not let a failing replication stop the tick', async () => {
    runPrune.mockResolvedValue(undefined);
    runReplication.mockRejectedValue(new Error('one target unreachable'));

    await expect(run({} as never, '*/10 * * * *', Date.now())).resolves.toBeUndefined();
  });

  it('never throws, whatever a task does', async () => {
    runPrune.mockRejectedValue(new Error('a'));
    runReplication.mockRejectedValue(new Error('b'));
    await expect(run({} as never, '*/10 * * * *', Date.now())).resolves.toBeUndefined();
  });

  it('runs both tasks even when one phase has several tasks', async () => {
    runPrune.mockResolvedValue(undefined);
    runReplication.mockResolvedValue(undefined);
    await run({} as never, '*/10 * * * *', Date.now());
    expect(runPrune).toHaveBeenCalledTimes(1);
    expect(runReplication).toHaveBeenCalledTimes(1);
  });
});