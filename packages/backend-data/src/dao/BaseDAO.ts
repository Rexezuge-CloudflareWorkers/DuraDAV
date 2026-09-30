import type { D1Queryable, D1Result } from '../utils/D1Types';
import { executeD1WithRetry } from '../utils/D1Utils';

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
