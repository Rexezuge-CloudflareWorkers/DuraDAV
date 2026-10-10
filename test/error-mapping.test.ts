/**
 * The live error→HTTP mapping, in place of the deleted second one.
 *
 * `packages/backend-services/src/errors/` held a complete, tested duplicate of
 * this logic with no production caller, and it disagreed with the live path —
 * it collapsed every 5xx to 500 while `BaseRoute.toErrorResponse` passed a
 * `DatabaseError`'s own code through. These assertions point at the mapper that
 * actually runs.
 */
import { describe, expect, it } from 'vitest';
import { BaseRoute } from '../apps/api/src/endpoints/IBaseRoute';
import { BadRequestError, DatabaseError, ForbiddenError, NotFoundError, UnauthorizedError } from '@durable-dav/backend-errors';

/**
 * `toErrorResponse` reads `Accept-Language` off the context for the masked-500
 * message, so a minimal context is all it needs.
 */
function context(): never {
  return { req: { header: (name: string) => (name === 'Accept-Language' ? 'en' : undefined) } } as never;
}

/**
 * `toErrorResponse` is synchronous — it builds a `Response`, it does not await
 * anything — so these read the value directly rather than awaiting it.
 */
function statusFor(error: unknown): number {
  return BaseRoute.toErrorResponse(context(), error).status;
}

function bodyFor(error: unknown): Promise<Record<string, { Type: string; Message: string }>> {
  return BaseRoute.toErrorResponse(context(), error).json() as Promise<Record<string, { Type: string; Message: string }>>;
}

describe('BaseRoute.toErrorResponse', () => {
  it('maps each client error to its own status', () => {
    expect(statusFor(new BadRequestError('bad'))).toBe(400);
    expect(statusFor(new UnauthorizedError('nope'))).toBe(401);
    expect(statusFor(new ForbiddenError('nope'))).toBe(403);
    expect(statusFor(new NotFoundError('gone'))).toBe(404);
  });

  it('keeps the AWS Exception envelope on a client error', async () => {
    await expect(bodyFor(new NotFoundError('gone'))).resolves.toEqual({
      Exception: { Type: 'NotFound', Message: 'gone' },
    });
  });

  it('answers 503 for a retryable DatabaseError', () => {
    // `retryable` was carried on the error and consulted by nobody, so a
    // transient D1 blip was indistinguishable from a permanent fault. This is
    // also the status `DavAuth` already used for the same type, so the JSON and
    // DAV planes agree.
    expect(statusFor(new DatabaseError('D1 busy', true))).toBe(503);
  });

  it('answers 500 for a non-retryable DatabaseError', () => {
    expect(statusFor(new DatabaseError('malformed row', false))).toBe(500);
  });

  it('masks an untyped error as a generic 500 without echoing its message', async () => {
    const response = BaseRoute.toErrorResponse(context(), new Error('internal detail: db password hunter2'));
    const body = (await response.json()) as { Exception: { Type: string; Message: string } };
    expect(response.status).toBe(500);
    expect(body.Exception.Type).toBe('InternalServerError');
    expect(body.Exception.Message).not.toContain('hunter2');
  });

  it('does not leak a non-Error throwable into the response body', async () => {
    const response = BaseRoute.toErrorResponse(context(), 'a bare string with a token sk_live_abc123');
    expect(await response.text()).not.toContain('sk_live_abc123');
  });
});