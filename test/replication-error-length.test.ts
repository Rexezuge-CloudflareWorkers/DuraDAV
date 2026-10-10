/**
 * The replication error-length caps.
 *
 * Four modules truncated an error string independently — `PlanExecutor` and
 * `VolumeReplicationRpc` at 300, `ReplicationRunner` and `replicationPassSql` at
 * 500 — and the SQL layer re-truncated a string its caller had already clamped.
 * They now share one statement of the rule.
 *
 * The `MAX_STORED_ERROR_LENGTH` in `replicationPassSql` is deliberately *not*
 * imported: `backend-data` is Layer 2 and may not import Layer 3. This test is
 * what stops the two copies drifting apart silently.
 */
import { describe, expect, it } from 'vitest';
import {
  STORED_ERROR_LENGTH,
  TRUNCATED_ERROR_LENGTH,
  errorMessageOf,
  truncateReplicationError,
  truncateReplicationReason,
} from '../packages/backend-services/src/replication/truncateError';

describe('replication error truncation', () => {
  it('clamps to the audit-trail limit', () => {
    expect(truncateReplicationError('x'.repeat(STORED_ERROR_LENGTH + 50))).toHaveLength(STORED_ERROR_LENGTH);
    expect(truncateReplicationError('x'.repeat(STORED_ERROR_LENGTH))).toHaveLength(STORED_ERROR_LENGTH);
    expect(truncateReplicationError('short')).toBe('short');
  });

  it('clamps to the tighter per-resource limit', () => {
    expect(truncateReplicationReason('x'.repeat(TRUNCATED_ERROR_LENGTH + 50))).toHaveLength(TRUNCATED_ERROR_LENGTH);
  });

  it('the audit-trail limit is the more generous one', () => {
    // last_error is the owner's record of *why* a pass failed and is read later,
    // so it is worth more characters than a reason inside a 207.
    expect(STORED_ERROR_LENGTH).toBeGreaterThan(TRUNCATED_ERROR_LENGTH);
  });

  it('is idempotent, so producing and storing ends cannot disagree', () => {
    const long = 'x'.repeat(5000);
    // The SQL layer re-applies its own clamp to an already-clamped value. That
    // is only safe because clamping a clamped string changes nothing.
    expect(truncateReplicationError(truncateReplicationError(long))).toBe(truncateReplicationError(long));
    expect(truncateReplicationReason(truncateReplicationError(long))).toBe(truncateReplicationReason(long));
  });

  it('picks message off an Error and stringifies anything else', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
    expect(errorMessageOf('boom')).toBe('boom');
    expect(errorMessageOf({ message: 'boom' })).toBe('[object Object]');
  });

  it('the DAO layer\'s duplicated constant still matches', () => {
    // Read from the source so the assertion tracks the real constant rather than
    // a copy that could itself drift.
    const source = readFileSync(
      new URL('../packages/backend-data/src/dao/replicationPassSql.ts', import.meta.url),
      'utf8',
    );
    const match = /MAX_STORED_ERROR_LENGTH = (\d+)/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(STORED_ERROR_LENGTH);
  });
});

import { readFileSync } from 'node:fs';