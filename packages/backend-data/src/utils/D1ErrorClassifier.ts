

/**
 * Patterns for a transient failure worth retrying.
 *
 * Checked **first**. A message matching both lists is treated as transient: one
 * wasted round trip against a real conflict is cheap, whereas mis-classifying a
 * blip as permanent turns a self-healing condition into a user-visible outage
 * that neither `BaseDAO.withRetry` nor the API's 503 mapping will cover.
 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /busy/i,
  /locked/i,
  /timeout/i,
  /timed?\s*out/i,
  /internal\s+(server\s+)?error/i,
  /connection/i,
  /network/i,
  /unavailable/i,
  /throttl/i,
  /too\s+many/i,
  /retry/i,
  /deadlock/i,
  /serialization/i,
];

/**
 * Patterns for a failure that will not get better on its own.
 *
 * Every entry is deliberately **narrower than its obvious spelling**. This list
 * used to be consulted first and carried bare `/range/i` and `/not\s+found/i`,
 * both of which match transient conditions:
 *
 * - `/range/i` matched `RangeError: Maximum call stack size exceeded` and
 *   `byte range not satisfiable` — neither is a row-level conflict.
 * - `/not\s+found/i` matched `host not found`, i.e. a DNS blip, which
 *   `/connection/i` now correctly claims first.
 */
const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /constraint/i,
  /\bunique\b/i,
  /primary\s+key/i,
  /foreign\s+key/i,
  /not\s+found/i,
  /\bsyntax\b/i,
  /parse\s+error/i,
  /no\s+such\s+(table|column|index)/i,
  /type\s+mismatch/i,
  // Was `/range/i`, which also matched a stack-overflow `RangeError` and
  // "byte range not satisfiable".
  /\bout\s+of\s+range\b/i,
  /invalid\s+argument/i,
  /\bpermission\b/i,
  /\bauthorization\b/i,
  /\bauthentication\b/i,
];

function isD1ErrorRetryable(errorMessage: string): boolean {
  if (!errorMessage) return false;

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(errorMessage)) return true;
  }

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(errorMessage)) return false;
  }

  return false;
}

export { isD1ErrorRetryable,  };

export {isMissingSchemaError} from '@durable-dav/shared/utils';