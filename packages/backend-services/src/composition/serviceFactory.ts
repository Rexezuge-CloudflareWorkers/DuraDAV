import type { D1Queryable } from '@durable-dav/backend-data/utils';

// Minimal structural env for scope creation.
interface RequestScopeEnv {
  DB: D1Queryable;
}

// Single audited unsafe-cast location for service envs. Services declare
// narrow `*Env` interfaces (e.g. `{ DB, MAX_* }`); the composition root holds
// the minimal `RequestScopeEnv`. Centralizing the cast here keeps call sites
// readable — and it is deliberately *not* a named exported function: as a
// `never`-returning helper it was callable from anywhere, and a function whose
// declared return type is `never` while it returns a value is a trap for the
// next reader.
function createService<T, D>(Ctor: new (env: never, deps?: D) => T, env: RequestScopeEnv, deps?: D): T {
  return new Ctor(env as never, deps);
}

export { createService };
export type { RequestScopeEnv };
