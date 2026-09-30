import type { DurableSqlStorage } from '@durable-dav/dav-store';
import {
  MAX_XML_BODY_BYTES,
  escapeXml,
  generatePropfindResponse,
  isProtectedProperty,
  parsePropfindRequest,
  parseProppatchRequest,
  readCappedText,
  renderEmptyPropertyElement,
  type DeadProperty,
} from '@durable-dav/webdav';

/**
 * Read a request body as UTF-8 XML, refusing anything over the cap.
 * Returns `null` when the caller should answer `413`.
 */
async function readXmlBody(request: Request): Promise<string | null> {
  const result = await readCappedText(request, MAX_XML_BODY_BYTES);
  return result.ok ? result.text : null;
}
import { hrefOf } from '../DavContext';
import type { DavBases } from '../DavContext';
import { pagingHeaders, readPagingHeaders, resolvePaging } from '../PropfindPaging';
import type { DavPaging } from '../PropfindPaging';
import type { DavLockGuard } from '../DavLockGuard';
import type { DavRepository } from '../DavRepository';

/**
 * Log a dead-property write failure instead of discarding it. A swallowed
 * error here produced a `200 OK` the client could not distinguish from success.
 */
function logPropWriteFailure(innerPath: string, property: DeadProperty, error: unknown): void {
  console.error('PROPPATCH write failed', {
    path: innerPath,
    namespaceURI: property.namespaceURI,
    localName: property.localName,
    error: error instanceof Error ? (error.stack ?? error.message) : error,
  });
}

async function handlePropfind(request: Request, innerPath: string, bases: DavBases, repo: DavRepository): Promise<Response> {
  const xml = await readXmlBody(request);
  if (xml === null) return new Response('Payload Too Large', { status: 413 });
  const parsed = parsePropfindRequest(xml);
  if (!parsed) return new Response('Bad Request', { status: 400 });
  const node = innerPath === '' ? repo.rootNode() : repo.nodeInfo(innerPath, bases.hrefBase);
  if (innerPath !== '' && !node) return new Response('Not Found', { status: 404 });
  let page = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">`;
  const props = parsed.mode === 'prop' ? parsed.properties : [];
  page += generatePropfindResponse(node, parsed.mode, props, bases.hrefBase);
  let paging: DavPaging | null = null;
  if (node?.isCollection ?? true) {
    const depth = request.headers.get('Depth') ?? 'infinity';
    if (depth !== '0' && depth !== '1' && depth !== 'infinity') return new Response('Bad Request', { status: 400 });
    // Only `Depth: 1` can be paged: `Depth: 0` has no children to page over, and
    // `Depth: infinity` walks the whole subtree, where a page boundary is
    // meaningless. A paging request for either is served in full.
    const requested = readPagingHeaders(request);
    if (requested !== null && depth === '1') paging = resolvePaging(requested, repo.countChildren(innerPath));
    if (depth !== '0') {
      const seen = new Set<string>();
      // Paged: one indexed scan for the page's names, then `nodeInfo` for those
      // names only. The unpaged branch is the one below, and its cost is the
      // reason this branch exists — `nodeInfo` is a `statInner` plus a
      // `dav_nodes` read, a `dav_locks` query and a `dav_props` read, per child.
      const directChildren = paging === null ? repo.listChildren(innerPath) : repo.listChildPage(innerPath, paging.offset, paging.limit).map((child) => child.name);
      for (const name of directChildren) {
        const childInner = repo.childInner(innerPath, name);
        seen.add(childInner);
        const child = repo.nodeInfo(childInner, bases.hrefBase);
        if (child) page += generatePropfindResponse(child, parsed.mode, props, bases.hrefBase);
      }
      if (depth === 'infinity') {
        for (const name of repo.listRecursive(innerPath)) {
          const childInner = repo.childInner(innerPath, name);
          if (seen.has(childInner)) continue;
          const child = repo.nodeInfo(childInner, bases.hrefBase);
          if (child) page += generatePropfindResponse(child, parsed.mode, props, bases.hrefBase);
        }
      }
    }
  }
  page += '\n</multistatus>\n';
  const headers: Record<string, string> = { 'Content-Type': 'application/xml; charset=utf-8' };
  if (paging !== null) Object.assign(headers, pagingHeaders(paging));
  return new Response(page, { status: 207, headers });
}

async function handleProppatch(
  request: Request,
  innerPath: string,
  bases: DavBases,
  repo: DavRepository,
  locks: DavLockGuard,
  sql: DurableSqlStorage,
): Promise<Response> {
  const locked = locks.assertLock(request, innerPath);
  if (locked) return locked;
  const node = innerPath === '' ? repo.rootNode() : repo.nodeInfo(innerPath, bases.hrefBase);
  if (!node && innerPath !== '') return new Response('Not Found', { status: 404 });
  const requestXml = await readXmlBody(request);
  if (requestXml === null) return new Response('Payload Too Large', { status: 413 });
  const parsed = parseProppatchRequest(requestXml);
  if (!parsed) return new Response('Bad Request', { status: 400 });
  const okSets: DeadProperty[] = [];
  const okRemoves: DeadProperty[] = [];
  const failedSets: DeadProperty[] = [];
  const failedRemoves: DeadProperty[] = [];
  for (const op of parsed.operations) {
    if (isProtectedProperty(op.property)) {
      if (op.action === 'set') failedSets.push(op.property);
      else failedRemoves.push(op.property);
      continue;
    }
    if (op.action === 'set') okSets.push(op.property);
    else okRemoves.push(op.property);
  }
  const hasProtectedFailures = failedSets.length > 0 || failedRemoves.length > 0;
  // RFC 4918 §9.2 requires each propstat to carry the *actual* outcome. The
  // previous shape swallowed SQL errors in a bare `catch` and then derived the
  // status only from protected-property rejections — so a write that threw was
  // reported to the client as `200 OK`, the client believed the property was
  // set, and the next PROPFIND did not show it. Outcomes are recorded per
  // property instead.
  const appliedSets: DeadProperty[] = [];
  const appliedRemoves: DeadProperty[] = [];
  const erroredSets: DeadProperty[] = [];
  const erroredRemoves: DeadProperty[] = [];
  if (!hasProtectedFailures) {
    for (const p of okSets) {
      try {
        sql.exec(
          `INSERT INTO dav_props (path, namespace_uri, local_name, prefix, value_xml) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, namespace_uri, local_name) DO UPDATE SET prefix=excluded.prefix, value_xml=excluded.value_xml`,
          innerPath,
          p.namespaceURI,
          p.localName,
          p.prefix,
          p.valueXml,
        );
        appliedSets.push(p);
      } catch (error) {
        erroredSets.push(p);
        logPropWriteFailure(innerPath, p, error);
      }
    }
    for (const p of okRemoves) {
      try {
        sql.exec(`DELETE FROM dav_props WHERE path = ? AND namespace_uri = ? AND local_name = ?`, innerPath, p.namespaceURI, p.localName);
        appliedRemoves.push(p);
      } catch (error) {
        erroredRemoves.push(p);
        logPropWriteFailure(innerPath, p, error);
      }
    }
  }
  const successStatus = 'HTTP/1.1 200 OK';
  const dependencyStatus = 'HTTP/1.1 424 Failed Dependency';
  const propstats = new Map<string, string[]>();
  const append = (p: DeadProperty, status: string) => {
    const list = propstats.get(status) ?? [];
    list.push(renderEmptyPropertyElement({ ...p, valueXml: '' }));
    propstats.set(status, list);
  };
  for (const p of appliedSets) append(p, successStatus);
  for (const p of appliedRemoves) append(p, successStatus);
  // Protected live properties cannot be written via PROPPATCH (§9.2).
  for (const p of failedSets) append(p, 'HTTP/1.1 403 Forbidden');
  for (const p of failedRemoves) append(p, 'HTTP/1.1 403 Forbidden');
  for (const p of erroredSets) append(p, dependencyStatus);
  for (const p of erroredRemoves) append(p, dependencyStatus);
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n<response>\n<href>${escapeXml(hrefOf(bases.hrefBase, innerPath, node?.isCollection ?? false))}</href>`;
  for (const [status, props] of propstats) {
    xml += `\n<propstat>\n<prop>\n${props.join('\n')}\n</prop>\n<status>${status}</status>\n</propstat>`;
  }
  xml += '\n</response>\n</multistatus>';
  return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

export { handlePropfind, handleProppatch };
