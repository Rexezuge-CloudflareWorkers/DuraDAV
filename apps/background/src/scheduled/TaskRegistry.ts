import { createLogger } from '@durable-dav/backend-runtime/logger';
import type { ScheduledTask } from './IScheduledTask';
import { ExpiredCredentialPruningTask } from './ExpiredCredentialPruningTask';
import { ReplicationSyncTask } from './ReplicationSyncTask';

const logger = createLogger('CronTasks');

interface TaskDefinition {
  name: string;
  phase: 1 | 2;
  make: () => ScheduledTask;
}

const CRON_TASK_FACTORIES: readonly TaskDefinition[] = [
  { name: 'ExpiredCredentialPruningTask', phase: 1, make: () => new ExpiredCredentialPruningTask() },
  // Phase 2: replication runs after the cheap hygiene pass, because a replication
  // that deletes on both sides should not be the first thing a tick spends its
  // budget on.
  { name: 'ReplicationSyncTask', phase: 2, make: () => new ReplicationSyncTask() },
];

function tasksForPhase(phase: 1 | 2): ScheduledTask[] {
  return CRON_TASK_FACTORIES.filter((d) => d.phase === phase).map((d) => d.make());
}

async function runScheduledTasks(env: Env, cron: string, scheduledTime: number): Promise<void> {
  logger.info(`Running scheduled tasks for ${cron} at ${scheduledTime}`);
  const phase1 = tasksForPhase(1);
  const phase2 = tasksForPhase(2);
  await Promise.all(phase1.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
  await Promise.all(phase2.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
}

export { CRON_TASK_FACTORIES, tasksForPhase, runScheduledTasks };
export { ExpiredCredentialPruningTask } from './ExpiredCredentialPruningTask';
export { ReplicationSyncTask } from './ReplicationSyncTask';
export type { ScheduledTask } from './IScheduledTask';
