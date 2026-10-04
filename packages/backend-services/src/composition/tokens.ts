import type { DavCredentialDAO, DavReplicationConflictDAO, DavReplicationDAO, DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import type { Token } from '@durable-dav/backend-runtime/di';
import type { AppConfiguration } from '@durable-dav/backend-runtime/config';
import type { KvCache } from '@durable-dav/backend-runtime/kv';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { UserService } from '../user/UserService';
import type { UserIdentityService } from '../identity/UserIdentityService';
import type { DavPermissionService } from '../dav/DavPermissionService';
import type { VolumeService } from '../dav/VolumeService';
import type { VolumeCredentialService } from '../dav/VolumeCredentialService';
import type { VolumeReplicationService } from '../dav/VolumeReplicationService';

// Central token registry for the per-request composition root
// (`requestScope.ts`). Call sites resolve services via
// `scope.get(Tokens.VolumeService)` instead of `new X(env)`.
//
// Tokens carry their value type (`Token<T>`) so `scope.get(...)` infers the
// service type without an explicit generic at call sites.
interface RequestScopeEnvShape {
  DB: D1Queryable;
}

const Tokens = {
  Env: Symbol('Env') as Token<RequestScopeEnvShape>,
  Db: Symbol('Db') as Token<D1Queryable>,
  KvCache: Symbol('KvCache') as Token<KvCache>,
  AppConfig: Symbol('AppConfig') as Token<AppConfiguration>,
  UserDAO: Symbol('UserDAO') as Token<() => Promise<UserDAO>>,
  UserEmailDAO: Symbol('UserEmailDAO') as Token<() => Promise<UserEmailDAO>>,
  NamespaceDAO: Symbol('NamespaceDAO') as Token<() => Promise<NamespaceDAO>>,
  DavVolumeDAO: Symbol('DavVolumeDAO') as Token<() => Promise<DavVolumeDAO>>,
  DavCredentialDAO: Symbol('DavCredentialDAO') as Token<() => Promise<DavCredentialDAO>>,
  DavReplicationDAO: Symbol('DavReplicationDAO') as Token<() => Promise<DavReplicationDAO>>,
  DavReplicationConflictDAO: Symbol('DavReplicationConflictDAO') as Token<() => Promise<DavReplicationConflictDAO>>,
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  UserService: Symbol('UserService') as Token<UserService>,
  UserIdentityService: Symbol('UserIdentityService') as Token<UserIdentityService>,
  DavPermissionService: Symbol('DavPermissionService') as Token<DavPermissionService>,
  VolumeService: Symbol('VolumeService') as Token<VolumeService>,
  VolumeCredentialService: Symbol('VolumeCredentialService') as Token<VolumeCredentialService>,
  VolumeReplicationService: Symbol('VolumeReplicationService') as Token<VolumeReplicationService>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
