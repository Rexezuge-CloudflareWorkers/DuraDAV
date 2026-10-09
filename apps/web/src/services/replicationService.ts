import type { BucketReplication, ReplicationConflict,  } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

/**
 * Intervals the UI offers, in minutes.
 *
 * Mirrored from `REPLICATION_INTERVALS` in `VolumeReplicationService`. The server
 * validates against its own closed list and answers a `400` for anything else, so
 * this copy exists only to render a dropdown that cannot produce an invalid
 * choice — the server remains the enforcement point.
 */
export const REPLICATION_INTERVALS = [15, 60, 360, 720, 1440, 10_080] as const;

/**
 * The modes the UI offers, mirroring the server's `REPLICATION_MODES`.
 *
 * `pull-only` is the one-way import: the remote is the authority, nothing is ever
 * pushed, and — with `mirrorDeletions` — local paths the remote lacks are removed
 * rather than kept.
 */
export const REPLICATION_MODES = ['keep-both', 'sync', 'pull-only', 'copy-only'] as const;

export type ReplicationMode = (typeof REPLICATION_MODES)[number];

/**
Human label for an interval. Minutes under an hour, then hours/days.
*/
export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return `${Number.isSafeInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const days = minutes / 1440;
  return `${Number.isSafeInteger(days) ? days : days.toFixed(1)}d`;
}

/**
What a target is, for display.
*/
export function targetLabel(replication: BucketReplication): string {
  if (replication.targetKind === 'dav-volume') {
    const base = `${replication.remoteOwner}/${replication.remoteVolume}`;
    return replication.remotePath === '' ? base : `${base}/${replication.remotePath}`;
  }
  return replication.remoteUrl + (replication.remotePath === '' ? '' : `/${replication.remotePath}`);
}

function replicationBase(owner: string, volume: string): string {
  return `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/replications`;
}

export async function listReplications(
  owner: string,
  volume: string,
): Promise<{ replications: BucketReplication[]; allowedIntervals: number[] }> {
  const data = await apiGet<{ replications?: BucketReplication[]; allowedIntervals?: number[] }>(replicationBase(owner, volume));
  return { replications: data.replications ?? [], allowedIntervals: data.allowedIntervals ?? [...REPLICATION_INTERVALS] };
}

export type CreateReplicationInput = {
  targetKind: 'dav' | 'dav-volume';
  remoteUrl?: string;
  remoteOwner?: string;
  remoteVolume?: string;
  remotePath?: string;
  authKind: 'none' | 'basic' | 'bearer';
  username?: string;
  secret?: string;
  mode: ReplicationMode;
  /**
   * `pull-only` only: delete local paths the remote does not have, making this an
   * exact mirror rather than a safe copy. Omitted for every other mode — the server
   * refuses it there, so sending it is a 400 rather than a no-op.
   */
  mirrorDeletions?: boolean;
  intervalMinutes: number;
  enabled?: boolean;
};

export async function createReplication(owner: string, volume: string, input: CreateReplicationInput): Promise<BucketReplication> {
  const data = await apiPost<{ replication: BucketReplication }>(replicationBase(owner, volume), input);
  return data.replication;
}

export async function updateReplication(
  owner: string,
  volume: string,
  replicationId: string,
  patch: { mode?: ReplicationMode; mirrorDeletions?: boolean; intervalMinutes?: number; enabled?: boolean },
): Promise<BucketReplication> {
  const data = await apiPatch<{ replication: BucketReplication }>(
    `${replicationBase(owner, volume)}/${encodeURIComponent(replicationId)}`,
    patch,
  );
  return data.replication;
}

export async function deleteReplication(owner: string, volume: string, replicationId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(`${replicationBase(owner, volume)}/${encodeURIComponent(replicationId)}`);
}

/**
 * Ask for one slice immediately.
 *
 * Resolves to `started` (202) when the server detached the work into
 * `waitUntil`, which is the normal case — the response deliberately does not wait
 * for the sync, because a client timeout here would look like a failed sync that
 * had in fact succeeded.
 */
export async function runReplicationNow(
  owner: string,
  volume: string,
  replicationId: string,
): Promise<{ sync: 'started' | 'done'; status?: string; error?: string | null }> {
  return apiPost<{ sync: 'started' | 'done'; status?: string; error?: string | null }>(
    `${replicationBase(owner, volume)}/${encodeURIComponent(replicationId)}/run`,
    {},
  );
}

export async function listReplicationConflicts(
  owner: string,
  volume: string,
  replicationId: string,
): Promise<ReplicationConflict[]> {
  const data = await apiGet<{ conflicts?: ReplicationConflict[] }>(
    `${replicationBase(owner, volume)}/${encodeURIComponent(replicationId)}/conflicts`,
  );
  return data.conflicts ?? [];
}

export async function resolveReplicationConflict(
  owner: string,
  volume: string,
  replicationId: string,
  conflictId: string,
): Promise<boolean> {
  const data = await apiPost<{ resolved: boolean }>(
    `${replicationBase(owner, volume)}/${encodeURIComponent(replicationId)}/conflicts/${encodeURIComponent(conflictId)}/resolve`,
    {},
  );
  return data.resolved;
}


export {type CreatedBucketReplication} from '../types';
