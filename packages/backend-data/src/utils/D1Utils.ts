import { DatabaseError } from '@durable-dav/backend-errors';
import { isD1ErrorRetryable } from './D1ErrorClassifier';
import type { D1Result } from './D1Types';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: (value: void) => void): unknown => setTimeout(resolve, ms));
}

/**
 * Backoff before the next attempt. Exponential, and uncapped by design: the
 * default base (100 ms) tops out under a second by attempt 3, while an operator
 * who sets a larger base gets the longer wait they asked for. The point is to
 * ride out a busy/locked D1, not to implement a rate limiter.
 */
function backoffMs(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** attempt;
}

function toDatabaseError(errorMessage: string, context: string): DatabaseError {
  return new DatabaseError(`Failed to ${context}: ${errorMessage}`, isD1ErrorRetryable(errorMessage));
}

/**
 * Run a D1 operation, retrying transient failures with exponential backoff.
 *
 * Two failure shapes are handled, because D1 reports both:
 *
 * 1. **A result with `success: false`.** The operation resolved; the database
 *    said no. Retried when the error classifies as transient.
 * 2. **A thrown error.** A transport-level rejection, which never carries a
 *    `D1Result` at all. Classified from the message the same way.
 *
 * A `DatabaseError` we raised ourselves in (1) arrives back through the `catch`
 * on the retry attempt, so it must be recognised and re-thrown rather than
 * re-wrapped into a second layer of `Failed to …`.
 */
async function executeD1WithRetry(
  operation: () => Promise<D1Result>,
  context: string,
  options?: { maxRetries?: number; baseDelayMs?: number },
): Promise<D1Result> {
  const maxRetries: number = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs: number = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isLastAttempt = attempt === maxRetries;
    try {
      const result: D1Result = await operation();
      if (result.success) return result;
      const errorMessage: string = result.error ?? 'Unknown database error';
      const failure = toDatabaseError(errorMessage, context);
      if (!isLastAttempt && failure.retryable) {
        await sleep(backoffMs(baseDelayMs, attempt));
        continue;
      }
      throw failure;
    } catch (error: unknown) {
      // Already classified above, or raised by the operation itself. Either way
      // re-wrapping would bury the original context.
      if (error instanceof DatabaseError) {
        if (!isLastAttempt && error.retryable) {
          await sleep(backoffMs(baseDelayMs, attempt));
          continue;
        }
        throw error;
      }
      if (error instanceof Error) {
        const failure = toDatabaseError(error.message, context);
        if (!isLastAttempt && failure.retryable) {
          await sleep(backoffMs(baseDelayMs, attempt));
          continue;
        }
        throw failure;
      }
      throw error;
    }
  }

  // Unreachable: the loop either returns a result or throws on its final
  // iteration. Present only so the function is total for a reader who has not
  // traced the `continue` paths.
  throw new DatabaseError(`Failed to ${context} after ${maxRetries + 1} attempts`);
}

export { executeD1WithRetry, sleep };
