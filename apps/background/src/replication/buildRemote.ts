import { decryptReplicationSecret, resolveReplicationKey } from '@durable-dav/backend-data/crypto';
import type { DavReplicationRow } from '@durable-dav/backend-data/dao';
import { RemoteUnavailableError } from '@durable-dav/backend-services/replication';
import type { RemoteVolume } from '@durable-dav/backend-services/replication';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { normalizeVolumeKey } from '@durable-dav/webdav';
import { DavHttpRemote } from './remote/DavHttpRemote';
import { basicAuthValue } from './remote/davHttpProtocol';
import { DavVolumeRemote } from './remote/DavVolumeRemote';
import type { ReplicaVolumeStub } from './remote/DavVolumeRemote';

/**
 * Choosing the transport for a replication, and authenticating to it.
 *
 * Split from `ReplicationRunner`, which orchestrates, so this file can hold every
 * place a replication *reaches outside itself*: the sibling Durable Object lookup, the
 * egress allowlist, and the one decryption in the feature. The runner's job is deciding
 * what should happen and recording it; whether a target is reachable and how this
 * Worker presents a credential is a separate concern that fails differently and is
 * tested separately.
 */

type RemoteAuth = { kind: 'none' } | { kind: 'basic'; value: string } | { kind: 'bearer'; token: string };

type BuildRemoteOptions = {
  env: Env;
  row: DavReplicationRow;
  config: AppConfiguration;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
};

/**
 * The egress allowlist, from configuration only.
 *
 * Never from the request body — an allowlist a caller can extend is not an allowlist.
 */
function allowedHosts(config: AppConfiguration): string[] {
  return [...config.getReplicationAllowedHostList()];
}

/**
 * `Basic` needs both halves but only the password-shaped blob is stored, so the
 * username travels as the `user:` prefix — matching how a client sends it and
 * keeping one secret in one column.
 */
function authHeader(authKind: string, secret: string): RemoteAuth {
  if (authKind === 'basic') {
    const separator = secret.indexOf(':');
    if (separator === -1) throw new RemoteUnavailableError('stored replication credential is malformed; rotate it');
    return { kind: 'basic', value: basicAuthValue(secret.slice(0, separator), secret.slice(separator + 1)) };
  }
  return authKind === 'bearer' ? { kind: 'bearer', token: secret } : { kind: 'none' };
}

async function decryptSecret(env: Env, row: DavReplicationRow): Promise<string> {
  if (row.encrypted_secret === null || row.secret_iv === null) return '';
  const key = await resolveReplicationKey({
    binding: env.REPLICATION_ENCRYPTION_KEY_SECRET,
    rawVar: env.REPLICATION_ENCRYPTION_KEY,
    isProduction: env.ENVIRONMENT === 'production',
  })();
  return decryptReplicationSecret({ ciphertext: row.encrypted_secret, iv: row.secret_iv }, key);
}

/**
 * A sibling bucket's Durable Object, or a refusal.
 *
 * `normalizeVolumeKey` is what makes the sweep and the front door agree on the isolate:
 * a raw-case `getByName` would fork a second object for the same bucket, and the two
 * would then hold two copies of the same tree.
 */
function volumeStub(env: Env, owner: string, volume: string): ReplicaVolumeStub {
  const namespace = (env as { DAV_VOLUME?: { getByName: (name: string) => unknown } }).DAV_VOLUME;
  if (!namespace) throw new RemoteUnavailableError('DAV_VOLUME binding is not configured');
  return namespace.getByName(normalizeVolumeKey(owner, volume)) as ReplicaVolumeStub;
}

/**
 * Build the transport for this replication's target.
 *
 * The credential is decrypted here and nowhere else, and a decryption failure
 * propagates. Reporting it as `failed` is correct; skipping authentication
 * instead would let the remote answer `401`, and the owner would spend an
 * afternoon on a key problem wearing a target problem's clothes.
 */
async function buildRemote(options: BuildRemoteOptions): Promise<RemoteVolume> {
  const { env, row, config, fetchImpl } = options;
  if (row.target_kind === 'dav-volume') {
    return new DavVolumeRemote({
      getStub: (owner, volume) => volumeStub(env, owner, volume),
      owner: row.remote_owner,
      volume: row.remote_volume,
      remotePath: row.remote_path,
      replicationId: row.replication_id,
    });
  }
  const secret = await decryptSecret(env, row);
  return new DavHttpRemote({
    baseUrl: row.remote_url,
    remotePath: row.remote_path,
    auth: authHeader(row.auth_kind, secret),
    fetchImpl,
    allowedHosts: allowedHosts(config),
    timeoutMs: config.getReplicationTimeoutMs(),
  });
}

/**
 * The sibling bucket a `dav-volume` target replicates into, or `null` for any other
 * kind. `ReplicationRunner` uses it to purge the right read caches.
 */
function siblingVolumeKey(row: DavReplicationRow): string | null {
  return row.target_kind !== 'dav-volume' || row.remote_owner === '' || row.remote_volume === '' ? null : normalizeVolumeKey(row.remote_owner, row.remote_volume);
}

export { allowedHosts, buildRemote, siblingVolumeKey };
export type { RemoteAuth };
