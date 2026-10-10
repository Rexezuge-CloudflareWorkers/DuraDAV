import type { D1Queryable, D1Result } from '../utils/D1Types';
import { D1_RETRY_DEFAULTS, backoffMs as d1BackoffMs, executeD1WithRetry, sleep } from '../utils/D1Utils';
import { isD1ErrorRetryable } from '../utils/D1ErrorClassifier';
import { DatabaseError } from '@durable-dav/backend-errors';

const SQL_IDENTIFIER_PATTERN = /^[a-z_]\w*$/i;

function assertSqlIdentifier(value: string, label: string): void {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid SQL identifier for ${label}: ${value}`);
  }
}

abstract class BaseDAO {
  constructor(protected readonly database: D1Queryable) {}

  protected withRetry(operation: () => Promise<D1Result>, context: string): Promise<D1Result> {
    return executeD1WithRetry(operation, context);
  }

  /**
   * Single-row read with the same retry and `DatabaseError` normalization as
   * `withRetry`.
   *
   * Writes have always gone through `withRetry`, but point reads called
   * `.first()` bare. That made a D1 failure on a read path a raw `D1_ERROR`
   * rather than a `DatabaseError`, so callers that document a typed
   * `DatabaseError` contract (`DavAuth`'s 503 on auth, for one) could not
   * actually see the error they handle — the branch was unreachable and the
   * failure surfaced as an opaque 500 instead.
   *
   * `first()` resolves to `null` for "no row", which is a success, not an error;
   * only a rejected statement is retried.
   *
   * The backoff comes from `d1BackoffMs` rather than an inlined
   * `baseDelayMs * 2 ** attempt`, because `D1_RETRY_DEFAULTS` is exported
   * precisely so the read and write schedules cannot drift — and an inlined copy
   * of the formula is exactly the drift it was meant to prevent. The unreachable
   * tail `throw` below is retained: `maxRetries` is a constant, but a loop whose
   * only exit is a `throw` inside `catch` is not provably exhaustive to the type
   * checker.
   */
  /**
   * Multi-row read, with the same retry and `DatabaseError` normalization.
   *
   * Separate from `withRetry` because that one is typed for a write's `D1Result`
   * and reads `result.success` off it — a shape `.all()` does not return. Both
   * existed as an accident of which helper each caller happened to reach for;
   * a list read had no retry at all.
   *
   * `.all()` returning `[]` for "no rows" is a success like `first()`'s `null`.
   */
  protected async allWithRetry<T>(operation: () => Promise<{ results?: T[] }>, context: string): Promise<T[]> {
    const statement = async (): Promise<{ success: true; results: T[] }> => {
      const rows = await operation();
      return { success: true, results: rows.results ?? [] };
    };
    const result = await executeD1WithRetry<{ results: T[] }>(statement, context);
    return result.results;
  }

  protected async firstWithRetry<T>(operation: () => Promise<T | null>, context: string): Promise<T | null> {
    for (let attempt = 0; attempt <= D1_RETRY_DEFAULTS.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        const retryable: boolean = isD1ErrorRetryable(message);
        if (retryable && attempt < D1_RETRY_DEFAULTS.maxRetries) {
          await sleep(d1BackoffMs(D1_RETRY_DEFAULTS.baseDelayMs, attempt));
          continue;
        }
        // `cause` is carried, not just the message: without it every caller
        // downstream has an `error.message` that reads
        // "Failed to <context>: D1_ERROR: ..." and no stack to go with it.
        throw new DatabaseError(`Failed to ${context}: ${message}`, retryable, { cause: error });
      }
    }
    throw new DatabaseError(`Failed to ${context} after ${D1_RETRY_DEFAULTS.maxRetries + 1} attempts`);
  }

  protected deleteRowsOlderThan(
    table: string,
    timeColumn: string,
    cutoff: number | string,
    limit: number,
    idColumn: string,
  ): Promise<number> {
    return BaseDAO.deleteOlderThan(this.database, table, timeColumn, cutoff, limit, idColumn);
  }

  // Generic batched delete of rows older than a cutoff. Mirrors the per-DAO
  // DELETE ... WHERE id IN (SELECT ... LIMIT ?) pattern with retry.
  protected static async deleteOlderThan(
    db: D1Queryable,
    table: string,
    timeColumn: string,
    cutoff: number | string,
    limit: number,
    idColumn: string,
  ): Promise<number> {
    assertSqlIdentifier(table, 'table');
    assertSqlIdentifier(timeColumn, 'timeColumn');
    assertSqlIdentifier(idColumn, 'idColumn');
    const result: D1Result = await executeD1WithRetry(
      (): Promise<D1Result> =>
        db
          .prepare(
            `DELETE FROM ${table}
             WHERE ${idColumn} IN (
               SELECT ${idColumn} FROM ${table}
               WHERE ${timeColumn} < ?
               LIMIT ?
             )`,
          )
          .bind(cutoff, limit)
          .run(),
      `delete old rows from ${table}`,
    );
    return (result.meta as { changes?: number })?.changes ?? 0;
  }
}

export { BaseDAO };
