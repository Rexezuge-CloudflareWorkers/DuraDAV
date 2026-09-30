import { describe, expect, it } from 'vitest';
import { AbstractEntrypointWorker } from '../packages/backend-runtime/src/base/AbstractEntrypointWorker';
import { AccessAuthService } from '@durable-dav/backend-services/auth';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';

/**
 * Two hardening fixes with a security shape each: an unauthenticated trigger
 * that was removed, and a configuration variable that was declared in three
 * places and read by nothing.
 */

class ProbeWorker extends AbstractEntrypointWorker {
  public onScheduledCalls = 0;
  public onRequestCalls = 0;

  protected onRequest(request: Request): Promise<Response> {
    this.onRequestCalls += 1;
    return Promise.resolve(new Response(`handled ${new URL(request.url).pathname}`, { status: 200 }));
  }

  protected onScheduled(): Promise<void> {
    this.onScheduledCalls += 1;
    return Promise.resolve();
  }
}

const ctx = { waitUntil: (): void => undefined, passThroughOnException: (): void => undefined };
const env = {} as Env;

describe('AbstractEntrypointWorker has no unauthenticated cron trigger', () => {
  /**
   * The bug: `fetch` short-circuited on `GET /__scheduled` *before* calling
   * `onRequest`, so it bypassed the app's security headers, its request scope,
   * and its rate limits — and any unauthenticated caller could fire the cron
   * Durable Object on demand, with `noRetry` stubbed to a no-op.
   */
  it('routes /__scheduled to the normal request path instead of the cron', async () => {
    const worker = new ProbeWorker();
    const response = await worker.fetch(new Request('https://host/__scheduled?cron=*'), env, ctx);

    expect(worker.onScheduledCalls).toBe(0);
    expect(worker.onRequestCalls).toBe(1);
    // Not 204, and not a bare 404: it is an ordinary handled request.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('handled /__scheduled');
  });

  it('does not run the cron for any method on that path', async () => {
    for (const method of ['GET', 'POST', 'DELETE', 'PROPFIND']) {
      const worker = new ProbeWorker();
      await worker.fetch(new Request('https://host/__scheduled', { method }), env, ctx);
      expect(worker.onScheduledCalls, method).toBe(0);
    }
  });

  it('still delivers the platform cron event', async () => {
    // The real trigger is the `triggers.crons` binding, which calls this
    // directly — nothing was lost by removing the HTTP path.
    const worker = new ProbeWorker();
    await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now(), noRetry: (): void => undefined }, env, ctx);
    expect(worker.onScheduledCalls).toBe(1);
    expect(worker.onRequestCalls).toBe(0);
  });

  it('answers 500 for an unhandled throw rather than propagating', async () => {
    class Throwing extends AbstractEntrypointWorker {
      protected onRequest(): Promise<Response> {
        return Promise.reject(new Error('boom'));
      }

      protected onScheduled(): Promise<void> {
        return Promise.resolve();
      }
    }
    const response = await new Throwing().fetch(new Request('https://host/x'), env, ctx);
    expect(response.status).toBe(500);
  });
});

describe('DEMO_MODE honours DEMO_USER_EMAIL', () => {
  const devEnv = { ENVIRONMENT: 'development', DEMO_MODE: 'true' };

  /**
   * The bug: `demoModeStrategy` returned the hard-coded `demo@example.com`
   * constant. `DEMO_USER_EMAIL` was declared in three places and read by
   * `AuthConfig.getDemoUserEmail`, which nothing called — so an operator who set
   * it for a staging deploy was silently ignored, with nothing in the config
   * saying the variable was inert.
   */
  it('authenticates as the configured address', async () => {
    const service = new AccessAuthService({ ...devEnv, DEMO_USER_EMAIL: 'staging@example.com' });
    await expect(service.getAuthenticatedUserEmail(new Request('https://host/'))).resolves.toBe('staging@example.com');
  });

  it('falls back to the constant when the variable is unset', async () => {
    const service = new AccessAuthService(devEnv);
    await expect(service.getAuthenticatedUserEmail(new Request('https://host/'))).resolves.toBe('demo@example.com');
  });

  it('normalizes case and surrounding whitespace', async () => {
    const service = new AccessAuthService({ ...devEnv, DEMO_USER_EMAIL: '  Staging@Example.COM  ' });
    await expect(service.getAuthenticatedUserEmail(new Request('https://host/'))).resolves.toBe('staging@example.com');
  });

  it('ignores a malformed override rather than trusting it', async () => {
    for (const bad of ['not-an-email', 'two words@example.com', '@example.com', 'a@b@c.com']) {
      const service = new AccessAuthService({ ...devEnv, DEMO_USER_EMAIL: bad });
      await expect(service.getAuthenticatedUserEmail(new Request('https://host/')), bad).resolves.toBe('demo@example.com');
    }
  });

  it('stays off entirely in production, whatever the variable says', async () => {
    // `isBypassAllowed` refuses the bypass in production, so the configured
    // address must not become an authentication path there.
    const service = new AccessAuthService({ ENVIRONMENT: 'production', DEMO_MODE: 'true', DEMO_USER_EMAIL: 'attacker@evil.example' });
    await expect(service.getAuthenticatedUserEmail(new Request('https://host/'))).rejects.toThrow();
  });

  it('exposes the value through AppConfiguration, which is where the service reads it', () => {
    expect(new AppConfiguration({ ...devEnv, DEMO_USER_EMAIL: 'staging@example.com' }).getDemoUserEmail()).toBe('staging@example.com');
    expect(new AppConfiguration(devEnv).getDemoUserEmail()).toBeNull();
  });
});
