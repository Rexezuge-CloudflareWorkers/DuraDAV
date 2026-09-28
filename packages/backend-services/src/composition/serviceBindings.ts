// Service bindings for the per-request composition root.
import type { DavCredentialDAO, DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { Container, Token } from '@durable-dav/backend-runtime/di';
import { UserIdentityService } from '@durable-dav/backend-services/identity';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';
import type { DaoThunks } from './serviceBindings/daoThunks';
import { bindCoreServices } from './serviceBindings/coreServices';

function bindServiceBindings(scope: Container, env: RequestScopeEnv): void {
  const getDao = <T>(token: Token<() => Promise<T>>): (() => Promise<T>) => scope.get(token);

  const daos: DaoThunks = {
    userDAO: getDao<UserDAO>(Tokens.UserDAO),
    userEmailDAO: getDao<UserEmailDAO>(Tokens.UserEmailDAO),
    namespaceDAO: getDao<NamespaceDAO>(Tokens.NamespaceDAO),
    davVolumeDAO: getDao<DavVolumeDAO>(Tokens.DavVolumeDAO),
    davCredentialDAO: getDao<DavCredentialDAO>(Tokens.DavCredentialDAO),
  };

  // One identity resolver per request scope, shared by `VolumeService` and any
  // route that needs the caller's account. Bind it here — above `bindCoreServices`
  // — so it is memoized in the same container every consumer resolves through.
  const identity = () => createIdentity(env, daos);
  scope.bind(Tokens.UserIdentityService, () => new UserIdentityService(env, { userDAO: daos.userDAO, userEmailDAO: daos.userEmailDAO }));

  bindCoreServices(scope, { env, daos, identity });
}

function createIdentity(env: RequestScopeEnv, daos: DaoThunks): Promise<UserIdentityService> {
  return Promise.resolve(new UserIdentityService(env, { userDAO: daos.userDAO, userEmailDAO: daos.userEmailDAO }));
}

export { bindServiceBindings };
