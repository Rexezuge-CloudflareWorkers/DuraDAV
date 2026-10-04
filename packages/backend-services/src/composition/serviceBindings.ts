// Service bindings for the per-request composition root.
import type { DavCredentialDAO, DavReplicationConflictDAO, DavReplicationDAO, DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { Container, Token } from '@durable-dav/backend-runtime/di';
import { UserIdentityService } from '../identity/UserIdentityService';
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
    davReplicationDAO: getDao<DavReplicationDAO>(Tokens.DavReplicationDAO),
    davReplicationConflictDAO: getDao<DavReplicationConflictDAO>(Tokens.DavReplicationConflictDAO),
  };

  // One identity resolver per request scope, shared by `VolumeService` and any
  // route that needs the caller's account.
  //
  // Dependents resolve it back *through the container* rather than being handed
  // a second constructor call. Passing `() => new UserIdentityService(...)` to
  // `bindCoreServices` looked equivalent but was not: it allocated a fresh
  // instance on every call, so `VolumeService` never shared the `byEmail` memo
  // and each request built two resolvers — one here, one per `VolumeService`
  // call — while the comment claimed they were the same object.
  scope.bind(Tokens.UserIdentityService, () => new UserIdentityService(env, { userDAO: daos.userDAO, userEmailDAO: daos.userEmailDAO }));
  // Async because that is the shape every other dependency in this package
  // takes (a `() => Promise<T>` thunk, so a DAO can be constructed lazily);
  // `UserIdentityService` is already-built, so this resolves on the microtask
  // queue rather than doing any work. The point is *which* instance it returns,
  // not how fast.
  const identity = () => Promise.resolve(scope.get(Tokens.UserIdentityService));

  bindCoreServices(scope, { env, daos, identity });
}

export { bindServiceBindings };
