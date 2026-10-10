type Factory<T> = (container: Container) => T;

// Branded token so `scope.get(Tokens.X)` infers `X` without an explicit
// generic at call sites. The brand is optional (and `unknown`-compatible) so
// `Token<Service>` remains assignable to `Token<unknown>` for Map storage.
type Token<T = unknown> = (string | symbol) & { readonly __type?: T };

/**
 * Minimal dependency-injection container (Factory + Singleton scopes).
 *
 * Composition roots (`createRequestScope`, `CronTasksWorker`, tests) wire
 * concrete implementations once; handlers resolve via `scope.get(Tokens.X)`.
 * Prefer constructor injection of `I*` ports at registration time over
 * inline `scope.get()` in business logic.
 */
class Container {
  private readonly factories = new Map<Token<unknown>, Factory<unknown>>();
  private readonly singletons = new Map<Token<unknown>, unknown>();

  public bind<T>(token: Token<T>, factory: Factory<T>): this {
    this.factories.set(token, factory);
    return this;
  }

  public bindValue<T>(token: Token<T>, value: T): this {
    this.singletons.set(token, value);
    return this;
  }

  /**
  Is a token bound (as a value or a factory)? Used to assert wiring.
  */
  public has<T>(token: Token<T>): boolean {
    return this.singletons.has(token) || this.factories.has(token);
  }

  public get<T>(token: Token<T>): T {
    if (this.singletons.has(token)) {
      return this.singletons.get(token) as T;
    }
    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`DI container has no binding for token: ${String(token)}`);
    }
    const instance = (factory as Factory<T>)(this);
    this.singletons.set(token, instance);
    return instance;
  }
}

export { Container };
export type { Factory, Token };
