// Minimal Workers-compatible context types so backend-runtime (Layer 1)
// typechecks without @cloudflare/workers-types. Apps pass the real
// ExecutionContext / ScheduledController which satisfy these structurally.
interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface WorkerScheduledController {
  cron: string;
  scheduledTime: number;
  noRetry(): void;
}

abstract class AbstractEntrypointWorker {
  /**
   * The HTTP request path.
   *
   * There is deliberately no `/__scheduled` branch here. It used to run before
   * `onRequest`, which made `GET /__scheduled` an unauthenticated, un-rated
   * trigger for the scheduled work: it bypassed the app's security headers, its
   * request scope, and its rate limits, and any caller could fire the cron
   * Durable Object on demand. `noRetry` was a `(): void => undefined` stub, so
   * the retry semantics were lost too.
   *
   * Nothing needed it — `scheduled()` is wired through the platform by the
   * `triggers.crons` entry in the wrangler config, which is how the cron
   * actually runs.
   */
  public async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    try {
      return await this.onRequest(request, env, ctx);
    } catch (err: unknown) {
      console.error('Unhandled error in fetch():', err);
      return new Response('Internal Error', { status: 500 });
    }
  }

  public async scheduled(event: WorkerScheduledController, env: Env, ctx: WorkerExecutionContext): Promise<void> {
    try {
      await this.onScheduled(event, env, ctx);
    } catch (err: unknown) {
      console.error('Unhandled error in scheduled():', err);
    }
  }

  protected abstract onRequest(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;

  protected abstract onScheduled(event: WorkerScheduledController, env: Env, ctx: WorkerExecutionContext): Promise<void>;
}

export { AbstractEntrypointWorker };
export type { WorkerExecutionContext, WorkerScheduledController };
