/* eslint-disable @typescript-eslint/require-await -- WebDAV read handlers keep async for uniform dispatch. */
import type { DofsFs } from '@durable-dav/dav-store';
import { escapeXml } from '@durable-dav/webdav';
import { fsPathOf, hrefOf } from '../DavContext';
import type { DavBases } from '../DavContext';
import { DavConditionalGuard } from '../DavConditionalGuard';
import { parseRangeHeader } from '../RangeParser';
import type { DavRepository } from '../DavRepository';

// Collection HTML browser + file byte serving (Command: one handler per
// WebDAV method family so `DavVolumeWorker` stays a thin Facade).
//
// `base` here is deliberately the *path* base, never the href base: these are
// `<a href>`s a browser resolves against the request URL, which is not what
// RFC 4918 §8.3 governs. A `root`-mode bucket whose links were anchored at `/`
// would have its human-facing listing 404 on the first click.
function renderCollectionHtml(
  base: string,
  innerPath: string,
  children: Array<{ name: string; childInner: string; isDirectory: boolean }>,
): string {
  let items = '';
  if (innerPath !== '') items += `<a href="../">..</a><br>`;
  for (const child of children) {
    const href = hrefOf(base, child.childInner, child.isDirectory);
    items += `<a href="${escapeXml(href)}">${escapeXml(child.name)}${child.isDirectory ? '/' : ''}</a><br>`;
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Durable-DAV</title><style>*{box-sizing:border-box}body{padding:10px;font-family:system-ui,sans-serif}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;border-radius:5px}a:hover{background:#0ea5e9;color:#fff}</style></head><body><h1>Durable-DAV ${escapeXml(base)}/${escapeXml(innerPath)}</h1><div>${items}</div></body></html>`;
}

async function handleGet(
  request: Request,
  innerPath: string,
  bases: DavBases,
  headOnly: boolean,
  repo: DavRepository,
  dofs: DofsFs,
): Promise<Response> {
  const st = repo.statInner(innerPath);
  const isBrowserNav = request.url.endsWith('/') || innerPath === '' || st.isDirectory;
  if (isBrowserNav) {
    if (innerPath !== '' && (!st.exists || !st.isDirectory)) return new Response('Not Found', { status: 404 });
    if (headOnly) return new Response(null, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const children = repo.listChildren(innerPath).map((name) => {
      const childInner = repo.childInner(innerPath, name);
      return { name, childInner, isDirectory: repo.statInner(childInner).isDirectory };
    });
    return new Response(renderCollectionHtml(bases.pathBase, innerPath, children), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (!st.exists) return new Response('Not Found', { status: 404 });
  const meta = repo.readMeta(innerPath);
  // RFC 7232 revalidation. Runs before the Range maths so a 304/412 answers
  // without reading any bytes.
  const conditional = new DavConditionalGuard().check(
    request,
    { etag: meta.etag ?? null, mtime: meta.mtime ?? st.mtime },
    { forRead: true },
  );
  if (conditional) return conditional;
  const { offset, length, contentRange, status } = parseRangeHeader(request.headers.get('Range'), st.size);

  // 416 carries no body and must not read the representation at all.
  if (status === 416) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': contentRange ?? `bytes */${st.size}`, 'Accept-Ranges': 'bytes' },
    });
  }

  let body: ReadableStream | ArrayBuffer;
  let contentLength = st.size;
  try {
    if (length === undefined) {
      body = dofs.readFile(fsPathOf(innerPath), {});
    } else {
      const buf = dofs.read(fsPathOf(innerPath), { offset, length });
      body = buf;
      contentLength = buf.byteLength;
    }
  } catch {
    return new Response('Not Found', { status: 404 });
  }

  const headers: Record<string, string> = {
    'Content-Type': meta.contentType ?? 'application/octet-stream',
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
  };
  if (meta.etag) headers['ETag'] = meta.etag;
  if (meta.mtime) headers['Last-Modified'] = new Date(meta.mtime).toUTCString();
  if (contentRange) headers['Content-Range'] = contentRange;

  // RFC 7233 §4.3: HEAD must mirror GET, including `206` + `Content-Range`.
  // The old shape always answered 200 and dropped the Content-Range.
  return new Response(headOnly ? null : (body as BodyInit), { status, headers });
}

export { handleGet, renderCollectionHtml };
