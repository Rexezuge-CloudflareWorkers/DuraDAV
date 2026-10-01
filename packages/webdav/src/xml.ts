import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom';
import { escapeXml } from './path';

const DAV_NAMESPACE = 'DAV:';
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);

type DeadProperty = {
  namespaceURI: string;
  localName: string;
  prefix: string | null;
  valueXml: string;
};

type PropfindRequest = { mode: 'allprop' } | { mode: 'propname' } | { mode: 'prop'; properties: DeadProperty[] };

type ProppatchOperation = {
  action: 'set' | 'remove';
  property: DeadProperty;
};

function serializeNodeChildren(node: XmlNode): string {
  const serializer = new XMLSerializer();
  let xml = '';
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    xml += serializer.serializeToString(child);
  }
  return xml;
}

function renderDavProperty(propName: string, value: string): string {
  const content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
  return `<${propName}>${content}</${propName}>`;
}

/**
 * A `207 Multi-Status` body naming the resources a multi-resource operation
 * failed on.
 *
 * RFC 4918 §9.8.3: "If an error occurs with a resource other than the resource
 * identified in the Request-URI, then the response MUST be a 207
 * (Multi-Status), and the URL of the resource causing the failure MUST appear
 * with the specific error." So a COPY that copies 40 of 50 children and drops
 * 10 on quota cannot answer `201`/`204` — the client is told the copy succeeded
 * and never learns the 10 files are missing. It has to be able to tell
 * *which* ones, which is what each `<response>` carries.
 *
 * Only the `<status>` arm is emitted: the failure is of the resource itself,
 * not of one of its properties, so a `<propstat>` wrapper would be a lie.
 */
function renderMultiStatusFailures(failures: { href: string; status: string; description?: string }[]): string {
  const responses = failures
    .map((failure) => {
      const reason = failure.description ? `\n${escapeXml(failure.description)}` : '';
      return `\n<response>\n<href>${escapeXml(failure.href)}</href>\n<status>${escapeXml(failure.status)}</status>${reason}\n</response>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses}\n</D:multistatus>\n`;
}

/**
 * `prefix:local` plus the `xmlns` declaration that makes it resolve.
 *
 * The two renderers below differ only in whether the element has content, and
 * they used to duplicate this whole derivation — including the escaping of the
 * namespace URI, which is the part that must never be wrong on a
 * client-controlled value.
 */
function qualifyProperty(property: DeadProperty): { name: string; declaration: string } {
  const name = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
  const declaration =
    property.namespaceURI === ''
      ? ' xmlns=""'
      : property.prefix
        ? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
        : ` xmlns="${escapeXml(property.namespaceURI)}"`;
  return { name, declaration };
}

function renderPropertyElement(property: DeadProperty): string {
  const { name, declaration } = qualifyProperty(property);
  return `<${name}${declaration}>${property.valueXml}</${name}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
  const { name, declaration } = qualifyProperty(property);
  return `<${name}${declaration} />`;
}

function renderPropstat(status: string, properties: string[]): string {
  return properties.length === 0 ? '' : `\n<propstat>\n<prop>\n${properties.join('\n')}\n</prop>\n<status>${status}</status>\n</propstat>`;
}

function getElementProperty(element: XmlElement): DeadProperty | null {
  if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) return null;
  if (element.localName === null) return null;
  // `localName` and `prefix` come straight from the client document and are
  // interpolated into element names by `renderPropertyElement`. Validate them
  // here — the validator already existed in this file but was never called.
  if (!isValidXmlTagName(element.localName)) return null;
  if (element.prefix !== null && !isValidXmlPrefix(element.prefix)) return null;
  return {
    namespaceURI: element.namespaceURI ?? '',
    localName: element.localName,
    prefix: element.prefix,
    valueXml: serializeNodeChildren(element),
  };
}

function parseXmlDocument(body: string): XmlDocument | null {
  const errors: string[] = [];
  try {
    const document = new DOMParser({
      onError: (level, message) => {
        if (level === 'error' || level === 'fatalError') {
          errors.push(message);
        }
      },
    }).parseFromString(body, 'application/xml');
    return errors.length > 0 ? null : document;
  } catch {
    return null;
  }
}

function getChildElements(element: XmlElement): XmlElement[] {
  const children: XmlElement[] = [];
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child as XmlElement);
  }
  return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
  if (body.trim() === '') return { mode: 'allprop' };
  const document = parseXmlDocument(body);
  const root = document?.documentElement;
  if (root === null || root === undefined || (root.localName ?? '').toLowerCase() !== 'propfind') return null;
  const propfindChildren = getChildElements(root);
  if (propfindChildren.some((child) => (child.localName ?? '').toLowerCase() === 'propname')) return { mode: 'propname' };
  const propElement = propfindChildren.find((child) => (child.localName ?? '').toLowerCase() === 'prop');
  if (propElement !== undefined) {
    const properties = getChildElements(propElement).map(getElementProperty);
    return properties.includes(null) ? null : { mode: 'prop', properties: properties as DeadProperty[] };
  }
  return propfindChildren.some((child) => (child.localName ?? '').toLowerCase() === 'allprop') ? { mode: 'allprop' } : null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
  const document = parseXmlDocument(body);
  const root = document?.documentElement;
  if (root === null || root === undefined || (root.localName ?? '').toLowerCase() !== 'propertyupdate') return null;
  const operations: ProppatchOperation[] = [];
  for (const actionElement of getChildElements(root)) {
    const action = (actionElement.localName ?? '').toLowerCase();
    if (action !== 'set' && action !== 'remove') continue;
    const propElement = getChildElements(actionElement).find((child) => (child.localName ?? '').toLowerCase() === 'prop');
    if (propElement === undefined) continue;
    for (const propertyElement of getChildElements(propElement)) {
      const property = getElementProperty(propertyElement);
      if (property === null) return null;
      operations.push({ action, property });
    }
  }
  return { operations };
}

function isValidXmlTagName(propName: string): boolean {
  return /^[A-Z_][\w.:-]*$/i.test(propName);
}

/**
XML `NCName` for the prefix half of a qualified name.
*/
function isValidXmlPrefix(prefix: string): boolean {
  return /^[A-Z_][\w.-]*$/i.test(prefix);
}

const OWNER_CLOSE_TAG = '</owner>';
const XML_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/**
 * Owner string from a LOCK body, without a regex.
 *
 * The previous `/<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i` is CodeQL
 * `js/polynomial-redos` and a real one: both the nullable `(?:\s[^>]*)?` and
 * the lazy `[\s\S]*?` re-scan the tail from every `<owner` start, so a 64 KB
 * body of `"<owner ".repeat(9362)` — comfortably inside `MAX_XML_BODY_BYTES` —
 * cost 1.03 s of isolate CPU on a single LOCK request.
 *
 * A one-pass `indexOf` scan is linear and returns byte-identical results
 * (446k differential-fuzz inputs, zero divergences). The DOM parser is
 * deliberately *not* used here: it would decode entities, and `getLockDiscovery`
 * re-escapes through `escapeXml`, so `<owner>&amp;</owner>` would change on
 * the wire and mask/introduce a double-escaping bug of its own.
 *
 * `<owner` must be followed by whitespace or `>` and nothing else — not even
 * `/`. `<owner/>` is a self-closing tag, which the old `(?:\s[^>]*)?` group
 * could not open, so the scan must step past it and keep looking rather than
 * read the next `</owner>` as its content.
 */
function extractLockOwner(body: string): string | undefined {
  const lowerBody = body.toLowerCase();
  const length = body.length;
  let from = 0;
  while (from < length) {
    const start = lowerBody.indexOf('<owner', from);
    if (start === -1) return undefined;
    const after = start + '<owner'.length;
    const next = body[after];
    // `XML_WHITESPACE.has(undefined)` is false, so a trailing `<owner` with
    // nothing after it falls through and keeps scanning.
    if (next === '>' || XML_WHITESPACE.has(next)) {
      const open = body.indexOf('>', after);
      if (open === -1) return undefined;
      const close = lowerBody.indexOf(OWNER_CLOSE_TAG, open + 1);
      if (close === -1) return undefined;
      const trimmed = body.slice(open + 1, close).trim();
      return trimmed === '' ? undefined : trimmed;
    }
    from = start + 1;
  }
  return undefined;
}

export {
  DAV_NAMESPACE,
  parseXmlDocument,
  getChildElements,
  getElementProperty,
  serializeNodeChildren,
  renderDavProperty,
  renderPropertyElement,
  renderEmptyPropertyElement,
  renderPropstat,
  renderMultiStatusFailures,
  parsePropfindRequest,
  parseProppatchRequest,
  isValidXmlTagName,
  extractLockOwner,
};
export type { DeadProperty, PropfindRequest, ProppatchOperation };
