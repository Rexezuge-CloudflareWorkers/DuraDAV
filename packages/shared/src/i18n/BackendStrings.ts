import { canonicalizeLanguageTag } from '../utils/LanguageTag';

const SUPPORTED_BACKEND_LOCALES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'ja', 'zh-CN', 'zh-TW', 'ko'] as const;

type SupportedBackendLocale = (typeof SUPPORTED_BACKEND_LOCALES)[number];

/**
 * The backend message bundle.
 *
 * Only `common` remains. It used to also carry `repo`, `token`, `issue`, `git`
 * and `namespace` groups — 15 keys across 12 locales, ~60 translated strings,
 * with **no production reader for any of them**. They are residue from a
 * Git-hosting product this server is not, and the only thing that ever read
 * them was a test asserting the formatter worked. Shipping them meant every
 * locale had to be edited in lockstep for a feature that does not exist here;
 * `validate_locales.mjs` would fail CI on a missing translation of a key no
 * code path could emit.
 *
 * `formatBackendString` goes the same way: its only caller was that test. A
 * message is either static or comes from a `ServiceError`, so there is nothing
 * left to interpolate.
 */
interface CommonStrings {
  unauthorized: string;
  forbidden: string;
  internalError: string;
}

interface BackendLocaleStrings {
  common: CommonStrings;
}

function normalizeBackendLocale(locale: string | null | undefined): SupportedBackendLocale {
  if (!locale) return 'en';
  const canonical = canonicalizeLanguageTag(locale);
  if ((SUPPORTED_BACKEND_LOCALES as readonly string[]).includes(canonical)) {
    return canonical as SupportedBackendLocale;
  }
  const base = canonical.split('-', 1)[0]?.toLowerCase() ?? 'en';
  if (base === 'zh') return 'zh-CN';
  const match = (SUPPORTED_BACKEND_LOCALES as readonly string[]).find((l) => l.toLowerCase() === base);
  return (match || 'en') as SupportedBackendLocale;
}

export type { BackendLocaleStrings, CommonStrings, SupportedBackendLocale };
export { SUPPORTED_BACKEND_LOCALES, normalizeBackendLocale };
