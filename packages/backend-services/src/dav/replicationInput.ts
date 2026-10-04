import { BadRequestError } from '@durable-dav/backend-errors';
import { normalizeRemoteUrl, RemoteUrlRejectedError } from '@durable-dav/shared/net';

/**
 * The replication request contract, and the only place it is interpreted.
 *
 * Split from `VolumeReplicationService` so the rules can be read in one place without
 * the storage calls interleaved: every function here is pure, answers `unknown` with a
 * narrowed value or a 400 naming the field, and touches nothing. That is the whole safety
 * argument for accepting a body from the internet, and it is easier to audit when it is
 * not surrounded by six `await`s.
 */

/**
 * Intervals offered for a replication, in minutes.
 *
 * A closed list rather than "any positive integer". The sweep budget is shared
 * across the whole deployment, so an interval of one minute does not make a
 * bucket sync more often — it makes it consume the budget the other buckets were
 * relying on, silently starving them, and the owner sees nothing but a target
 * that is never up to date.
 */
const REPLICATION_INTERVALS = [15, 60, 360, 720, 1440, 10_080] as const;

const REPLICATION_MODES = ['copy-only', 'sync', 'keep-both'] as const;
const REPLICATION_AUTH_KINDS = ['none', 'basic', 'bearer'] as const;
const REPLICATION_TARGET_KINDS = ['dav', 'dav-volume'] as const;

const MAX_REMOTE_PATH_LENGTH = 512;
const MAX_REMOTE_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 1024;
const MAX_NAME_LENGTH = 256;

type ReplicationAuthKind = (typeof REPLICATION_AUTH_KINDS)[number];
type ReplicationTargetKind = (typeof REPLICATION_TARGET_KINDS)[number];

/**
 * Everything a caller may send. Every field is `unknown` on purpose.
 */
type ReplicationCreateInput = {
  targetKind?: unknown;
  remoteUrl?: unknown;
  remoteOwner?: unknown;
  remoteVolume?: unknown;
  remotePath?: unknown;
  authKind?: unknown;
  username?: unknown;
  secret?: unknown;
  mode?: unknown;
  intervalMinutes?: unknown;
  enabled?: unknown;
};

type ReplicationPatchInput = {
  mode?: unknown;
  intervalMinutes?: unknown;
  enabled?: unknown;
};

/**
 * Narrow an untrusted value against a closed set.
 *
 * Type before value on every field, for the reason `parseVolumePatch` documents
 * and repeats here: an unknown `mode` reaching the `CHECK` constraint is a 500
 * rather than the 400 the caller deserves, and a `"false"` reaching `enabled` is
 * a *silent* difference in who may read the target. A wrong-typed value must be
 * a 400 naming the field.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new BadRequestError(`${field} is required`);
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new BadRequestError(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new BadRequestError(`${field} must be a boolean`);
  return value;
}

/**
 * The interval must be one of the offered values.
 *
 * Checked against the list as a *number* before any string coercion, so
 * `"60"` and `60` are both accepted while `"60 minutes"` and `1e9` are not.
 */
function normalizeInterval(value: unknown, field = 'intervalMinutes'): number {
  if (value === undefined || value === null) return 60;
  const parsed = typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(parsed) || !(REPLICATION_INTERVALS as readonly number[]).includes(parsed)) {
    throw new BadRequestError(`${field} must be one of: ${REPLICATION_INTERVALS.join(', ')}`);
  }
  return parsed;
}

/**
 * Subdirectory on the remote, normalized.
 *
 * Rejects a leading slash and any `..` segment rather than stripping them: a
 * path that has to be rewritten to become safe is a path someone constructed to
 * leave the configured root, and quietly clamping it would sync content
 * somewhere the owner never named — and in `keep-both` mode, delete there too.
 */
function normalizeRemotePath(value: unknown): string {
  const raw = optionalString(value, 'remotePath', MAX_REMOTE_PATH_LENGTH);
  if (raw === '') return '';
  if (raw.startsWith('/')) throw new BadRequestError('remotePath must not start with "/"');
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new BadRequestError('remotePath must not contain ".." segments');
  return segments.join('/');
}

/**
 * A target URL that has passed the egress policy.
 *
 * The policy's messages are written for the owner configuring a target, so they are
 * surfaced verbatim rather than replaced with a generic 400 — the difference between
 * "that host resolves to a private address" and "invalid request" is the whole reason
 * the policy is reachable from here.
 */
function requireRemoteUrl(value: unknown, allowedHosts: readonly string[]): string {
  const raw = optionalString(value, 'remoteUrl', MAX_REMOTE_URL_LENGTH);
  if (raw === '') throw new BadRequestError('remoteUrl is required when targetKind is dav');
  try {
    return normalizeRemoteUrl(raw, { allowedHosts: [...allowedHosts] });
  } catch (error) {
    if (error instanceof RemoteUrlRejectedError) throw new BadRequestError(error.message);
    throw error;
  }
}

export {
  normalizeRemotePath,
  normalizeInterval,
  oneOf,
  optionalBoolean,
  optionalString,
  requireRemoteUrl,
  MAX_NAME_LENGTH,
  MAX_SECRET_LENGTH,
  REPLICATION_INTERVALS,
  REPLICATION_MODES,
  REPLICATION_AUTH_KINDS,
  REPLICATION_TARGET_KINDS,
};
export type { ReplicationCreateInput, ReplicationPatchInput, ReplicationAuthKind, ReplicationTargetKind };
