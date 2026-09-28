// Shared DAO thunk bundle for service bindings.
import type { DavCredentialDAO, DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { UserIdentityService } from '../../identity/UserIdentityService';
import type { RequestScopeEnv } from '../serviceFactory';

interface DaoThunks {
  userDAO: () => Promise<UserDAO>;
  userEmailDAO: () => Promise<UserEmailDAO>;
  namespaceDAO: () => Promise<NamespaceDAO>;
  davVolumeDAO: () => Promise<DavVolumeDAO>;
  davCredentialDAO: () => Promise<DavCredentialDAO>;
}

interface ServiceGroupContext {
  env: RequestScopeEnv;
  daos: DaoThunks;
  /**
   * The single per-scope identity resolver. Services must share this instance
   * rather than each constructing their own: its address->account memo is the
   * reason the ownership path costs one query per request instead of one per
   * comparison, and two instances would each pay that cost.
   */
  identity: () => Promise<UserIdentityService>;
}

export type { DaoThunks, ServiceGroupContext };
