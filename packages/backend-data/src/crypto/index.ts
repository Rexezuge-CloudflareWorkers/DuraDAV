export { encryptReplicationSecret, decryptReplicationSecret, generateReplicationKey, ReplicationKeyError, KEY_BYTES } from './aes-gcm';
export type { EncryptedEnvelope } from './aes-gcm';
export { resolveReplicationKey } from './replicationKey';
export type { ReplicationKeyProvider, ReplicationKeySources, SecretsStoreKeyBinding } from './replicationKey';
