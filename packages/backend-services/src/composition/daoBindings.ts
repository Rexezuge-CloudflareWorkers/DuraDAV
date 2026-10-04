import {
  DavCredentialDAO,
  DavReplicationConflictDAO,
  DavReplicationDAO,
  DavVolumeDAO,
  NamespaceDAO,
  UserDAO,
  UserEmailDAO,
} from '@durable-dav/backend-data/dao';
import { Container } from '@durable-dav/backend-runtime/di';
import type { Token } from '@durable-dav/backend-runtime/di';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';

/**
 * Memoized async factory helper.
 *
 * Rejections are never cached: a transient D1 failure must not poison the
 * whole request scope — the next resolve retries.
 */
function memoizeAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = fn();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

/**
 * Bind one DAO as a lazy, memoized factory so `createRequestScope` never
 * constructs a DAO the request does not actually resolve.
 *
 * This is a generic function rather than a `Array<[Token, factory]>` table
 * because a heterogeneous table cannot tie each token to the type its factory
 * returns: the old table was declared
 * `Array<[Token<() => Promise<unknown>>, () => Promise<unknown>]>`, which
 * silently erased the token types, so swapping two DAO factories still
 * compiled and only failed at the first `.first()` call.
 */
function bindDao<T>(scope: Container, token: Token<() => Promise<T>>, create: () => Promise<T>): void {
  scope.bindValue(token, memoizeAsync(create));
}

function bindDaoBindings(scope: Container, env: RequestScopeEnv): void {
  bindDao(scope, Tokens.UserDAO, () => Promise.resolve(new UserDAO(env.DB)));
  bindDao(scope, Tokens.UserEmailDAO, () => Promise.resolve(new UserEmailDAO(env.DB)));
  bindDao(scope, Tokens.NamespaceDAO, () => Promise.resolve(new NamespaceDAO(env.DB)));
  bindDao(scope, Tokens.DavVolumeDAO, () => Promise.resolve(new DavVolumeDAO(env.DB)));
  bindDao(scope, Tokens.DavCredentialDAO, () => Promise.resolve(new DavCredentialDAO(env.DB)));
  bindDao(scope, Tokens.DavReplicationDAO, () => Promise.resolve(new DavReplicationDAO(env.DB)));
  bindDao(scope, Tokens.DavReplicationConflictDAO, () => Promise.resolve(new DavReplicationConflictDAO(env.DB)));
}

export { bindDaoBindings };
