import type { D1Queryable, D1Result } from '../utils/D1Types';
import { D1_RETRY_DEFAULTS, executeD1WithRetry, sleep } from '../utils/D1Utils';
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
   * only a rejected statement goes through `executeD1WithRetry`.
   */
  protected async firstWithRetry<T>(operation: () => Promise<T | null>, context: string): Promise<T | null> {
    for (let attempt = 0; attempt <= D1_RETRY_DEFAULTS.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        const retryable: boolean = isD1ErrorRetryable(message);
        if (retryable && attempt < D1_RETRY_DEFAULTS.maxRetries) {
          await sleep(D1_RETRY_DEFAULTS.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw new DatabaseError(`Failed to ${context}: ${message}`, retryable);
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
