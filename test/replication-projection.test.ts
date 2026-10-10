/**
 * The replication wire projection.
 *
 * `toReplicationJson` / `toConflictJson` are the only thing standing between a
 * stored credential and a client, and the module's whole argument is that every
 * field is *named* rather than copied — so the test that matters is the one that
 * adds a column to the row type and checks it does not appear in the output.
 * A projection that grew by spreading the row would publish `encrypted_secret`
 * the first time someone added a column.
 */
import { describe, expect, it } from 'vitest';
import { toConflictJson, toReplicationJson } from '../apps/api/src/workers/routes/replicationProjection';

const row = {
  replication_id: 'rep_1',
  target_kind: 'dav-http',
  remote_url: 'https://remote.example.com/dav',
  remote_owner: '',
  remote_volume: '',
  remote_path: 'backup',
  auth_kind: 'basic',
  mode: 'sync',
  mirror_deletions: 1,
  interval_minutes: 15,
  enabled: 1,
  last_run_at: 1_700_000_000,
  last_status: 'ok',
  last_error: null,
  consecutive_failures: 0,
  pass_started_at: null,
  created_at: 1_699_000_000,
  updated_at: 1_700_000_000,
};

describe('toReplicationJson', () => {
  it('never publishes the stored credential', () => {
    // The column exists on the row and must not reach the wire.
    const withSecret = { ...row, encrypted_secret: 'BASE64CIPHERTEXT', secret_iv: 'BASE64IV' };
    const projected = toReplicationJson(withSecret as never);
    expect(projected).not.toHaveProperty('encrypted_secret');
    expect(projected).not.toHaveProperty('secret_iv');
    expect(JSON.stringify(projected)).not.toContain('BASE64CIPHERTEXT');
  });

  it('publishes exactly the named fields, so a new column needs a deliberate edit', () => {
    const projected = toReplicationJson({ ...row, future_column: 'sensitive' } as never);
    expect(Object.keys(projected).sort()).toEqual(
      [
        'authKind',
        'consecutiveFailures',
        'createdAt',
        'enabled',
        'intervalMinutes',
        'lastError',
        'lastRunAt',
        'lastStatus',
        'mode',
        'mirrorDeletions',
        'passInFlight',
        'remoteOwner',
        'remotePath',
        'remoteUrl',
        'remoteVolume',
        'replicationId',
        'targetKind',
        'updatedAt',
      ].sort(),
    );
    expect(projected).not.toHaveProperty('future_column');
  });

  it('converts the integer flags to booleans', () => {
    // The client renders the state it is in; `1`/`0` arriving as numbers is the
    // difference between "mirror deletions on" and "a flag that happens to be 1".
    expect(toReplicationJson(row).mirrorDeletions).toBe(true);
    expect(toReplicationJson(row).enabled).toBe(true);
    expect(toReplicationJson({ ...row, mirror_deletions: 0 }).mirrorDeletions).toBe(false);
    expect(toReplicationJson({ ...row, enabled: 0 }).enabled).toBe(false);
  });

  it('reports an open pass as a boolean, which is also the deletion gate', () => {
    expect(toReplicationJson(row).passInFlight).toBe(false);
    expect(toReplicationJson({ ...row, pass_started_at: 1_700_000_000 }).passInFlight).toBe(true);
  });

  it('carries the target fields the UI renders', () => {
    const projected = toReplicationJson(row);
    expect(projected.remoteUrl).toBe('https://remote.example.com/dav');
    expect(projected.remotePath).toBe('backup');
    expect(projected.targetKind).toBe('dav-http');
  });

  it('surfaces the last error so the owner can see why a pass failed', () => {
    expect(toReplicationJson({ ...row, last_error: 'target unreachable' }).lastError).toBe('target unreachable');
    expect(toReplicationJson(row).lastError).toBeNull();
  });
});

describe('toConflictJson', () => {
  const conflict = {
    conflict_id: 'c_1',
    path: 'docs/report.pdf',
    winner: 'remote',
    kept_path: 'docs/report.conflict-1700000000.pdf',
    kind: 'conflict',
    detected_at: 1_700_000_000,
    resolved_at: null,
  };

  it('publishes the kept path, which is the only place the loser survives', () => {
    const projected = toConflictJson(conflict);
    expect(projected.keptPath).toBe('docs/report.conflict-1700000000.pdf');
    expect(projected.path).toBe('docs/report.pdf');
  });

  it('states whether the conflict was a conflict or a deletion', () => {
    // Inference from "was a copy written" once recorded a resolved sync conflict
    // as a deletion — in the one place the feature promises to be trustworthy
    // about what it destroyed.
    expect(toConflictJson(conflict).kind).toBe('conflict');
    expect(toConflictJson({ ...conflict, kind: 'deletion' }).kind).toBe('deletion');
  });

  it('omits replicationId, which the client is already scoped by', () => {
    expect(toConflictJson(conflict)).not.toHaveProperty('replicationId');
  });

  it('preserves a null keptPath for a deletion', () => {
    expect(toConflictJson({ ...conflict, kept_path: null, kind: 'deletion' }).keptPath).toBeNull();
  });
});