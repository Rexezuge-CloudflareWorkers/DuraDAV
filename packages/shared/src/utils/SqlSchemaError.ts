/**
 * Distinguishes "the table or column isn't there" from every other way a SQL
 * statement can fail.
 *
 * Both SQL surfaces this monorepo uses — D1 and Durable Object SQLite — report
 * a missing relation the same way, in the same words. That makes this a Layer 0
 * concern: `backend-data` and `dav-store` are both Layer 2 and may not import
 * each other, so the predicate they share has to live below both.
 *
 * The rule it exists to enforce is fail-closed: a caller may degrade to `[]` or
 * a fallback query **only** on `true` here, and must rethrow everything else.
 * Catching broadly is how "this resource has no dead properties" comes to mean
 * "the database is corrupt" — a silent data-loss report, which is worse than an
 * error.
 */
const MISSING_SCHEMA_PATTERN = /no\s+such\s+(?:table|column|index)/i;

function isMissingSchemaError(error: unknown): boolean {
  if (error instanceof Error) return MISSING_SCHEMA_PATTERN.test(error.message);
  // A thrown string is legal; anything else (a number, an object, `undefined`)
  // carries no message to match against.
  return typeof error === 'string' && MISSING_SCHEMA_PATTERN.test(error);
}

export { isMissingSchemaError, MISSING_SCHEMA_PATTERN };
