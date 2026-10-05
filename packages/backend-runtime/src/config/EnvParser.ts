class EnvParser {
  public static positiveInt(env: unknown, key: string, defaultValue: string): number {
    const value = this.readString(env, key);
    const parsed = Number(value ?? defaultValue);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number(defaultValue);
  }

  /**
   * Whether an explicitly-set numeric var is a usable positive integer.
   *
   * Used by `AppConfiguration.validate()` to *report* misconfiguration at
   * startup while still running with the default. The throwing counterpart
   * (`strictPositiveInt`) is gone: no caller opted in, and a fail-fast parse on
   * a request path would turn a config typo into a 500 rather than a warning.
   */
  public static isValidPositiveInt(env: unknown, key: string): boolean {
    const value = this.readString(env, key);
    if (value === undefined) return true;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
  }

  public static string(env: unknown, key: string, defaultValue: string): string {
    return this.readString(env, key) ?? defaultValue;
  }

  public static boolean(env: unknown, key: string, defaultValue: string): boolean {
    return (this.readString(env, key) ?? defaultValue) === 'true';
  }

  private static readString(env: unknown, key: string): string | undefined {
    return (env as Record<string, string | undefined>)[key];
  }
}

export { EnvParser };
