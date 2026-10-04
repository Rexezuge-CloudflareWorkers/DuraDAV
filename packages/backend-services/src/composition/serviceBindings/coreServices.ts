// Identity/governance bindings: auth, users, volumes, permissions.
// Single DavPermissionService and UserIdentityService bindings live here;
// dependents resolve them via the container, never `new`.
//
// Relative imports, not `@durable-dav/backend-services/*`. Self-imports gave
// one module two specifiers in the same package, which a bundler is free to
// emit twice — harmless for a stateless class, but it would silently duplicate
// `AccessAuthService`'s `private static readonly jwksCache` Map. Every other
// file in this package uses relative paths for the same reason.
import { AccessAuthService } from '../../auth/AccessAuthService';
import { DavPermissionService } from '../../dav/DavPermissionService';
import { VolumeService } from '../../dav/VolumeService';
import { VolumeCredentialService } from '../../dav/VolumeCredentialService';
import { VolumeReplicationService } from '../../dav/VolumeReplicationService';
import { UserService } from '../../user/UserService';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import type { Container } from '@durable-dav/backend-runtime/di';
import { Tokens } from '../tokens';
import { createService } from '../serviceFactory';
import type { ServiceGroupContext } from './daoThunks';

function bindCoreServices(scope: Container, { env, daos, identity }: ServiceGroupContext): void {
  scope.bind(Tokens.AppConfig, () => AppConfiguration.fromEnv(env));
  scope.bind(Tokens.AccessAuthService, () => createService(AccessAuthService, env));
  // `UserIdentityService` is bound in `serviceBindings.ts` (it is the shared
  // instance every identity consumer resolves through), not here.
  scope.bind(Tokens.UserService, () =>
    createService(UserService, env, {
      userDAO: daos.userDAO,
      userEmailDAO: daos.userEmailDAO,
      namespaceDAO: daos.namespaceDAO,
      volumeDAO: daos.davVolumeDAO,
    }),
  );
  scope.bind(Tokens.DavPermissionService, () => createService(DavPermissionService, env, {}));
  scope.bind(Tokens.VolumeService, () =>
    createService(VolumeService, env, {
      volumeDAO: daos.davVolumeDAO,
      credentialDAO: daos.davCredentialDAO,
      identity,
    }),
  );
  scope.bind(Tokens.VolumeCredentialService, () =>
    createService(VolumeCredentialService, env, {
      credentialDAO: daos.davCredentialDAO,
    }),
  );
  // Replication reads `REPLICATION_ENCRYPTION_KEY` off the env, not through
  // `AppConfiguration` — it is a secret, and the config facade reports numbers
  // and policy while secrets stay out of `validate()`'s numeric sweep.
  scope.bind(Tokens.VolumeReplicationService, () =>
    createService(VolumeReplicationService, env, {
      replicationDAO: daos.davReplicationDAO,
      conflictDAO: daos.davReplicationConflictDAO,
    }),
  );
}

export { bindCoreServices };
