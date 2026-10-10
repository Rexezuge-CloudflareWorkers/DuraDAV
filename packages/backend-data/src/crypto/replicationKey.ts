/**
 * Resolving the replication encryption key.
 *
 * ## Why this exists
 *
 * `REPLICATION_ENCRYPTION_KEY` was a plain `wrangler secret`, which is a base64
 * string sitting in the environment of every isolate. Secrets Store exists for
 * exactly this shape of value — a long-lived key that must not be readable from
 * the Worker environment — so the key is read from a `secrets_store_secrets`
 * binding instead.
 *
 * ## The binding is preferred; the raw var is a non-production fallback
 *
 * `resolveReplicationKey` reads the binding first. The plain var remains
 * readable so local dev and unit tests work with no Secrets Store provisioned,
 * and it is **refused in production**: silently accepting a plaintext env var
 * there would make the two look interchangeable when they are a different trust
 * boundary, and a deployment could "work" while the key sits in the environment
 * exactly as before.
 *
 * ## Fail-closed and memoized
 *
 * A missing or unreadable key throws `ReplicationKeyError` rather than
 * returning a passphrase, because the alternative stores a remote target's
 * password in the clear on precisely the deployments that misconfigured the
 * key, and reports `ok` while doing it. The promise is memoized — including its
 * rejection — so one failing binding is not re-fetched per lookup.
 */

import { ReplicationKeyError } from './aes-gcm';

/**
 * The subset of `SecretsStoreSecret` this module uses.
 *
 * Structural rather than the global type so the module stays unit-testable in a
 * plain Node environment, and so `backend-data` (Layer 2) does not need a
 * `workers-types` ambient declaration to describe it.
 */
interface SecretsStoreKeyBinding {
  get(): Promise<string>;
}

interface ReplicationKeySources {
  /**
  `secrets_store_secrets` binding. Preferred, and the only one used in production.
  */
  binding?: SecretsStoreKeyBinding;
  /**
  Plain env var. Local dev and tests only.
  */
  rawVar?: string;
  /**
  Whether this deployment is production. Gates the `rawVar` fallback.
  */
  isProduction: boolean;
}

/**
 * One memoized key source.
 *
 * Returns base64 of exactly 32 bytes, or throws `ReplicationKeyError`. The
 * throw is deliberate at *fetch* time rather than at use time so a
 * misconfigured deployment is reported as a key problem, not as "authentication
 * failed" against a remote — the same reasoning the AES-GCM envelope documents.
 */
function resolveReplicationKey({ binding, rawVar, isProduction }: ReplicationKeySources): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return (): Promise<string> => {
    pending ??= (async (): Promise<string> => {
      if (binding) return binding.get();
      if (rawVar && !isProduction) return rawVar;
      if (isProduction) {
        throw new ReplicationKeyError(
          'REPLICATION_ENCRYPTION_KEY_SECRET is not configured; set the Secrets Store binding in production ' +
            '(the plain REPLICATION_ENCRYPTION_KEY var is refused there on purpose)',
        );
      }
      throw new ReplicationKeyError('REPLICATION_ENCRYPTION_KEY is not configured; remote replication credentials cannot be stored');
    })();
    return pending;
  };
}

/**
 * A key provider, for injecting into services that must not depend on the
 * environment shape themselves.
 */
type ReplicationKeyProvider = () => Promise<string>;

export { resolveReplicationKey };
export type { ReplicationKeyProvider, ReplicationKeySources, SecretsStoreKeyBinding };