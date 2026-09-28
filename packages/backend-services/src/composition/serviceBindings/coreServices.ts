// Identity/governance bindings: auth, users, volumes, permissions.
// Single DavPermissionService and UserIdentityService bindings live here;
// dependents resolve them via the container, never `new`.
import { AccessAuthService } from '@durable-dav/backend-services/auth';
import { DavPermissionService } from '@durable-dav/backend-services/dav';
import { VolumeService } from '@durable-dav/backend-services/dav';
import { VolumeCredentialService } from '@durable-dav/backend-services/dav';
import { UserService } from '@durable-dav/backend-services/user';
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
}

export { bindCoreServices };
