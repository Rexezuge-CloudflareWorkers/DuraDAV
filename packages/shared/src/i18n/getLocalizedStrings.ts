import type { BackendLocaleStrings, SupportedBackendLocale } from './BackendStrings';
import { normalizeBackendLocale } from './BackendStrings';
import { deStrings } from './locales/de';
import { enStrings } from './locales/en';
import { esStrings } from './locales/es';
import { frStrings } from './locales/fr';
import { itStrings } from './locales/it';
import { jaStrings } from './locales/ja';
import { koStrings } from './locales/ko';
import { nlStrings } from './locales/nl';
import { plStrings } from './locales/pl';
import { ptStrings } from './locales/pt';
import { zhCNStrings } from './locales/zh-CN';
import { zhTWStrings } from './locales/zh-TW';

const BACKEND_STRINGS: Record<SupportedBackendLocale, BackendLocaleStrings> = {
  en: enStrings,
  de: deStrings,
  fr: frStrings,
  es: esStrings,
  it: itStrings,
  nl: nlStrings,
  pt: ptStrings,
  pl: plStrings,
  ja: jaStrings,
  'zh-CN': zhCNStrings,
  'zh-TW': zhTWStrings,
  ko: koStrings,
};

function getBackendStrings(locale: string | null | undefined): BackendLocaleStrings {
  return BACKEND_STRINGS[normalizeBackendLocale(locale)];
}

export { BACKEND_STRINGS, getBackendStrings };
