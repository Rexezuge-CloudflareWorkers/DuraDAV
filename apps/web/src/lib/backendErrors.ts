import { getBackendErrorType } from './api';

type TranslateFn = (key: string, fallback: string) => string;

const BACKEND_TYPE_TO_I18N_KEY: Record<string, string> = {
  BadRequest: 'errors.backend.badRequest',
  Unauthorized: 'errors.backend.unauthorized',
  Forbidden: 'errors.backend.forbidden',
  NotFound: 'errors.backend.notFound',
  Conflict: 'errors.backend.conflict',
  PayloadTooLarge: 'errors.backend.payloadTooLarge',
  RateLimited: 'errors.backend.rateLimited',
  MethodNotAllowed: 'errors.backend.methodNotAllowed',
  DatabaseError: 'errors.backend.databaseError',
  InternalServerError: 'errors.backend.internalError',
};

const BACKEND_TYPE_TO_FALLBACK: Record<string, string> = {
  BadRequest: 'Bad Request.',
  Unauthorized: 'Authentication Required.',
  Forbidden: 'Access Denied.',
  NotFound: 'Not Found.',
  Conflict: 'Conflict.',
  PayloadTooLarge: 'Payload Too Large.',
  RateLimited: 'Too Many Requests. Try Again Later.',
  MethodNotAllowed: 'Method Not Allowed.',
  DatabaseError: 'Service Temporarily Unavailable.',
  InternalServerError: 'Internal Server Error.',
};

/**
 * Strip trailing full stops so "Conflict." and "Conflict" compare equal.
 *
 * Written as an index scan rather than `/\.+$/`: the pattern is flagged as
 * super-linear by `sonarjs`, and a trailing run of dots is short enough that a
 * plain walk is both clearer and free.
 */
function withoutTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === FULL_STOP) end -= 1;
  return value.slice(0, end);
}

/**
U+002E, as a code point.
*/
const FULL_STOP = 46;

/**
 * Maps a fetch failure to a localized user-facing message.
 *
 * Backend `Message` values stay English on the wire by design, so a typed
 * `BackendError` resolves to `errors.backend.*` and every other failure falls
 * back to the operation-specific localized message — raw backend English never
 * reaches the notice bar *as a replacement for* a localized string.
 *
 * It is appended, never substituted. The previous shape returned the mapped
 * string and discarded `error.message` entirely, which made the whole of
 * `extractErrorMessage` — the AWS-envelope parsing, the legacy shape, the
 * 500-char truncation — unobservable at 13 of its 15 call sites. The visible
 * cost: `Conflict` is one word and `PayloadTooLarge` is two, so a duplicate
 * bucket name, the 10-credentials-per-bucket cap, the 100-bucket cap, and the
 * 50 MB upload cap all surfaced as content-free one-liners even though the
 * backend had sent a specific `Exception.Message`. A user who hits the upload
 * cap is told "Payload Too Large." and has no way to learn the limit.
 *
 * Localized first, server detail second, and only when the two differ — so a
 * message that merely restates the type does not produce "Conflict. Conflict."
 */
function toLocalizedErrorMessage(t: TranslateFn, error: unknown, fallbackKey: string, fallbackDefault: string): string {
  const type = getBackendErrorType(error);
  const base =
    type === null ? undefined : BACKEND_TYPE_TO_I18N_KEY[type] && t(BACKEND_TYPE_TO_I18N_KEY[type], BACKEND_TYPE_TO_FALLBACK[type] ?? fallbackDefault);
  const localized = base ?? t(fallbackKey, fallbackDefault);
  const detail = error instanceof Error ? error.message.trim() : '';
  if (detail === '' || detail === localized) return localized;
  // Avoid doubling a type name the mapped string already leads with ("Conflict"
  // / "Conflict."), which is the common case for a bare `Exception.Message`.
  return base !== undefined && withoutTrailingDots(detail) === withoutTrailingDots(localized) ? localized : `${localized} (${detail})`;
}

export { toLocalizedErrorMessage };
export type { TranslateFn };
