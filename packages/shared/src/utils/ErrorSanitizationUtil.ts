// Layer 0 stays dependency-free: HTTP status codes are plain numbers.
// Previously typed as `ContentfulStatusCode` from `hono`, which pulled a
// framework dependency into the base error layer.
const BEARER_PATTERN = /\bbearer\s+\S+/gi;
const BASIC_PATTERN = /\bbasic\s+\S+/gi;
const TOKEN_KV_PATTERN = /((?:access|refresh|id)[_-]?token\s*[:=]\s*).\S*/gi;
const SECRET_KV_PATTERN = /((?:client[_-]?secret|auth[_-]?code|code[_-]?verifier|durable-dav-pat)\s*[:=]\s*).\S*/gi;
const TOKEN_QUERY_PATTERN = /([?&](?:access_token|refresh_token|code|client_secret)=).[^&\s;}]*/gi;
const JWT_PATTERN = /eyJ[\w-].+[\w-].+[\w./+=~-]/g;
const GOOGLE_TOKEN_PATTERN = /ya29..[\w.-]+/g;
const PAT_PATTERN = /durable-dav-pat:[\w-]+/g;

// Secret-safe logging (Otter `ErrorSanitizationUtil` pattern).
// Replacements are inline literals for `unicorn/no-unsafe-string-replacement`
// and act as a CodeQL `js/clear-text-logging` masking barrier.
class ErrorSanitizationUtil {
  public static sanitizeMessage(message: string): string {
    return message
      .replaceAll(PAT_PATTERN, '[REDACTED-PAT]')
      .replaceAll(BEARER_PATTERN, 'Bearer [REDACTED]')
      .replaceAll(BASIC_PATTERN, 'Basic [REDACTED]')
      .replaceAll(TOKEN_KV_PATTERN, '$1[REDACTED]')
      .replaceAll(SECRET_KV_PATTERN, '$1[REDACTED]')
      .replaceAll(TOKEN_QUERY_PATTERN, '$1[REDACTED]')
      .replaceAll(JWT_PATTERN, '[REDACTED-JWT]')
      .replaceAll(GOOGLE_TOKEN_PATTERN, '[REDACTED]');
  }

  public static sanitizeErrorForLogging(error: unknown): string {
    if (error instanceof Error) {
      const redacted = this.sanitizeMessage(error.message);
      const stack = error.stack ? `\n${this.sanitizeMessage(error.stack)}` : '';
      return `${error.name}: ${redacted}${stack}`;
    }
    return this.sanitizeMessage(String(error));
  }

  /**
   * A redacted error, for a structured log payload.
   *
   * `error instanceof Error ? (error.stack ?? error.message) : error` was
   * written out at eight call sites, and every one of them bypassed the
   * redaction above — so an error whose message carried a credential would be
   * logged in the clear. Those sites are error paths in the DAV plane, which
   * never see an Access JWT, so no live leak was found; but a logging helper
   * that only redacts when the caller remembers to call it is not a redaction
   * boundary.
   */
  public static stackForLog(error: unknown): unknown {
    return this.sanitizeErrorForLogging(error);
  }
}

export { ErrorSanitizationUtil };
