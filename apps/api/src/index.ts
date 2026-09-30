import { DurableDavWorker } from './workers/DurableDavWorker';

const worker = new DurableDavWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => worker.scheduled(event, env, ctx),
};

export { CronTasksWorker, DavVolumeWorker, CredentialVerifierDO } from '@durable-dav/background';
