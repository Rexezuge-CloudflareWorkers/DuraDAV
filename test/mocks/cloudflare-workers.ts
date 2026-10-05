class DurableObject<TEnv = Env> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

class WorkflowEntrypoint<TEnv = Env, _TPayload = unknown> {
  protected env: TEnv;

  constructor(ctx: unknown, env: TEnv) {
    void ctx;
    this.env = env;
  }
}

/**
 * The base class `dofs`' `Fs` extends.
 *
 * Needed for the mock to be loadable at all: `class Fs extends RpcTarget` fails
 * to evaluate with "Class extends value undefined" when the base is missing,
 * which is a module-load error rather than a test failure, so it surfaces as an
 * unimportable `dav-store` barrel and no unit test can reach `DavRepository`.
 *
 * Deliberately empty. On the platform this class marks which methods are callable
 * across an RPC boundary; nothing in the unit suite calls `dofs` through RPC —
 * those tests pass a fake `DofsFs` — and the RPC surface itself is covered by the
 * workerd integration suite, where the platform's own `RpcTarget` is present. An
 * empty base keeps the fake honest instead of pretending to implement dispatch.
 */
class RpcTarget {}

export { DurableObject, WorkflowEntrypoint, RpcTarget };
