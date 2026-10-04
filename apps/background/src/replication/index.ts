/**
 * The public surface of background replication.
 *
 * A real module rather than a deep import, so `@durable-dav/background/replication`
 * resolves to one file. `apps/api` reaches the runner from here and nothing else:
 * the transports and the planner's collaborators are not its business, and this
 * boundary is what keeps the god-file count and the dependency graph honest.
 */

export { ReplicationRunner } from './ReplicationRunner';
export type { RunResult, ReplicationRunnerDeps } from './ReplicationRunner';
export type { LocalReplicaStub, Slice } from './collectSlice';
