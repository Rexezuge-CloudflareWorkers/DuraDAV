import {
  DAV_NAMESPACE,
  type DeadProperty,
  renderDavProperty,
  renderEmptyPropertyElement,
  renderPropertyElement,
  renderPropstat,
} from './xml';
import { escapeXml, getResourceHref } from './path';
import { getLockDiscovery, getSupportedLock, type LockDetails } from './locks';

type DavLiveProperties = {
  creationdate: string | undefined;
  displayname: string | undefined;
  getcontentlength: string | undefined;
  getcontenttype: string | undefined;
  getetag: string | undefined;
  getlastmodified: string | undefined;
  resourcetype: string;
  supportedlock: string;
  lockdiscovery: string;
};

type DavNodeInfo = {
  key: string;
  isCollection: boolean;
  size: number;
  etag: string | undefined;
  mtime: Date;
  crtime: Date;
  contentType: string | undefined;
  /**
   * Derived from the last path segment by the caller, not stored. There is no
   * `contentLanguage`: nothing ever set one, so it was permanently `undefined`
   * and `getcontentlanguage` never appeared in a multistatus.
   */
  displayname: string | undefined;
  locks: LockDetails[];
  deadProperties: DeadProperty[];
};

const DEAD_PROPERTY_PREFIX = 'dead_property:';
const LOCK_PROTECTED_NAMES = new Set([
  'lock_token',
  'lock_owner',
  'lock_scope',
  'lock_depth',
  'lock_timeout',
  'lock_expires_at',
  'lock_root',
  'lock_records',
  'supportedlock',
  'lockdiscovery',
]);

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
  return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function isProtectedProperty(propName: string | DeadProperty): boolean {
  const local = typeof propName === 'string' ? (propName.split(':').pop() ?? propName) : propName.localName;
  return (
    LOCK_PROTECTED_NAMES.has(local) ||
    (typeof propName !== 'string' &&
      propName.namespaceURI === DAV_NAMESPACE &&
      ['supportedlock', 'lockdiscovery', 'resourcetype'].includes(local))
  );
}

function toLiveProperties(node: DavNodeInfo | null, base = ''): DavLiveProperties {
  if (node === null) {
    return {
      creationdate: new Date().toUTCString(),
      displayname: undefined,
      getcontentlength: '0',
      getcontenttype: undefined,
      getetag: undefined,
      getlastmodified: new Date().toUTCString(),
      resourcetype: '<collection />',
      supportedlock: getSupportedLock(),
      lockdiscovery: '',
    };
  }
  return {
    creationdate: node.crtime.toUTCString(),
    displayname: node.displayname,
    getcontentlength: node.isCollection ? undefined : String(node.size),
    getcontenttype: node.isCollection ? undefined : node.contentType,
    getetag: node.isCollection ? undefined : node.etag,
    getlastmodified: node.mtime.toUTCString(),
    resourcetype: node.isCollection ? '<collection />' : '',
    supportedlock: getSupportedLock(),
    lockdiscovery:
      node.locks.length === 0
        ? ''
        : getLockDiscovery(node.locks.map((l) => ({ ...l, root: getResourceHref(node.key, node.isCollection, base) }))),
  };
}

/**
 * One live property, for a named `<prop>` request.
 *
 * `base` must be threaded through or the answer is wrong: `lockdiscovery`
 * embeds a `lockroot` href built from the volume prefix, so omitting it made
 * the *same resource* return `/dir/file.txt` here and `/alice/photos/dir/
 * file.txt` from the `allprop` arm. RFC 4918 §8.3 requires every href to
 * resolve against the request URL, so one of those two answers is a
 * non-conforming href that sends a client outside the volume.
 */
function getLivePropertyValue(node: DavNodeInfo | null, property: DeadProperty, base = ''): string | undefined {
  if (property.namespaceURI !== DAV_NAMESPACE) return undefined;
  // Why `Object.hasOwn` and not a plain index: `property.localName` is
  // client-controlled, so a plain lookup walks the prototype chain and hands
  // back `constructor`/`__proto__`/`toString` — `escapeXml` then calls
  // `.replaceAll` on a function and throws, turning any PROPFIND into a 500.
  // The own-property check also removes the need for a `keyof` assertion.
  const live: Record<string, string | undefined> = toLiveProperties(node, base);
  return Object.hasOwn(live, property.localName) ? live[property.localName] : undefined;
}

function generatePropfindResponse(
  node: DavNodeInfo | null,
  mode: 'allprop' | 'propname' | 'prop',
  requested: DeadProperty[] = [],
  base = '',
): string {
  const href = getResourceHref(node?.key ?? '', node?.isCollection ?? true, base);
  const dead = node?.deadProperties ?? [];

  let ok: string[] = [];
  const missing: string[] = [];

  if (mode === 'allprop') {
    // Only `allprop` needs every live property rendered, so `toLiveProperties`
    // is called here and not for the other two modes — a `prop`/`propname`
    // request would otherwise build a `lockdiscovery` string per requested
    // property and discard it.
    const live = toLiveProperties(node, base);
    ok = [...Object.entries(live).flatMap(([key, value]) => (value === undefined ? [] : [renderDavProperty(key, value)])), ...dead.map(renderPropertyElement)];
  } else if (mode === 'propname') {
    // Names only, so the base never matters: every value is empty.
    const live = toLiveProperties(node);
    ok = [
      ...Object.entries(live).flatMap(([key, value]) => (value === undefined ? [] : [renderDavProperty(key, '')])),
      ...dead.map((p) => renderEmptyPropertyElement({ ...p, valueXml: '' })),
    ];
  } else {
    for (const property of requested) {
      const liveValue = getLivePropertyValue(node, property, base);
      if (liveValue !== undefined) {
        ok.push(renderDavProperty(property.localName, liveValue));
        continue;
      }
      const found = dead.find((d) => d.namespaceURI === property.namespaceURI && d.localName === property.localName);
      if (found) ok.push(renderPropertyElement(found));
      else missing.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
    }
  }

  return `\n<response>\n<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', ok)}${renderPropstat('HTTP/1.1 404 Not Found', missing)}\n</response>`;
}

export { getDeadPropertyKey, isProtectedProperty, toLiveProperties, getLivePropertyValue, generatePropfindResponse };
export type { DavLiveProperties, DavNodeInfo };
