export { RESERVED_NAMESPACE_NAMES, RESERVED_NAMESPACE_NAMES_LIST, isReservedNamespaceName } from './reservedNames';
export {
  USERNAME_PATTERN,
  USERNAME_MAX_LENGTH,
  VOLUME_NAME_PATTERN,
  VOLUME_NAME_MAX_LENGTH,
  isValidUsername,
  isValidVolumeName,
} from './naming';

export {
  DAV_HREF_PREFIX_MODES,
  DEFAULT_DAV_HREF_PREFIX_MODE,
  isDavHrefPrefixMode,
  toDavHrefPrefixMode,
  readDavHrefPrefixMode,
} from './davHref';
export type { DavHrefPrefixMode } from './davHref';

export const DEMO_USER_EMAIL = 'demo@example.com';
