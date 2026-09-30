import type { DavEntry } from '../types';
import { BackendError, readDav } from '../lib/api';
import { parseMultistatus, stripSlashes } from '../lib/davXml';

/**
Public volume base, as it appears in `DAV:href` values (RFC 4918 §8.3).
*/
function davBase(owner: string, volume: string): string {
  return `/${owner}/${volume}`;
}

function volumeBase(owner: string, volume: string): string {
  // Session-authenticated browser plane (Git read-model pattern):
  // same DO content as the WebDAV plane but authed via the Access session,
  // so private buckets never answer 401 + WWW-Authenticate (no native
  // username/password prompt). External WebDAV clients keep using
  // `/:owner/:volume` with bucket Basic credentials.
  return `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/files`;
}

function entryUrl(owner: string, volume: string, innerPath: string): string {
  // Defence in depth: even if a caller skips `cleanPath`, a `..` segment must
  // never escape the volume base. `encodeURIComponent` leaves `.` alone, so
  // the browser would resolve `..` out of `/user/volumes/<o>/<v>/files`.
  const clean = stripSlashes(innerPath)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  const suffix = clean === '' ? '/' : `/${clean.split('/').map(encodeURIComponent).join('/')}`;
  const url = `${volumeBase(owner, volume)}${suffix}`;
  // Fail closed rather than emit a request outside the volume.
  const base = volumeBase(owner, volume);
  if (!new URL(url, globalThis.location?.origin ?? 'https://localhost').pathname.startsWith(`${base}/`)) {
    throw new Error('Refusing to build a DAV URL outside the volume base.');
  }
  return url;
}

async function davFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status === 207) return response;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let type: string | null = null;
    let message = text || `HTTP ${response.status}`;
    try {
      const data = JSON.parse(text) as { Exception?: { Type?: string; Message?: string } };
      if (typeof data?.Exception?.Type === 'string') type = data.Exception.Type;
      if (typeof data?.Exception?.Message === 'string' && data.Exception.Message) message = data.Exception.Message;
    } catch {
      // Plain-text WebDAV errors surface as-is (truncated).
      message = message.length > 500 ? `${message.slice(0, 500)}…` : message;
    }
    throw new BackendError(message, type, response.status);
  }
  // Callers of the mutating helpers discard the response entirely. An unread
  // body holds the connection open, so a multi-file upload plus MKCOL/DELETE/
  // MOVE could exhaust the per-origin connection pool. Drain it.
  void response.body?.cancel().catch(() => undefined);
  return response;
}

/**
 * One page of a directory listing.
 *
 * `paged` is `false` when the server did not answer with `X-Dav-Page-Count`,
 * which means it does not implement paging (an older backend behind a
 * Durable-DAV-Router, say). The caller then treats the returned entries as the
 * complete listing and pages them itself — it must not assume a body with no
 * paging headers is a complete listing *and* a partial one at once.
 */
export interface DavListing {
  entries: DavEntry[];
  page: number;
  limit: number;
  /**
  Total entries, or `null` when the server did not report one.
  */
  total: number | null;
  paged: boolean;
}

function readPagingHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function listDirectory(
  owner: string,
  volume: string,
  innerPath: string,
  page?: { page: number; limit: number },
): Promise<DavListing> {
  const base = entryUrl(owner, volume, innerPath);
  // `entryUrl` has no query of its own today, but the join is written so a
  // future `?backend=` selector cannot produce two `?` and silently drop the
  // paging parameters — the failure mode would be a page that always looks
  // like page 1.
  const query = page === undefined ? '' : `?page=${encodeURIComponent(String(page.page))}&limit=${encodeURIComponent(String(page.limit))}`;
  const url = `${base}${query}`;
  const body = `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>`;
  const response = await davFetch(url, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  // Read the headers before the body: `readDav` consumes the stream.
  const total = readPagingHeader(response, 'X-Dav-Page-Count');
  const effectivePage = readPagingHeader(response, 'X-Dav-Page');
  const effectiveLimit = readPagingHeader(response, 'X-Dav-Page-Limit');
  const xml = await readDav(response);
  const entries = parseMultistatus(xml, innerPath, davBase(owner, volume));
  return {
    entries,
    // Echo back the *effective* values: a request for page 99 of a 1-page
    // collection is served page 1, and the URL should say so.
    page: effectivePage ?? page?.page ?? 1,
    limit: effectiveLimit ?? page?.limit ?? Math.max(1, entries.length),
    total,
    paged: total !== null,
  };
}

export async function createDirectory(owner: string, volume: string, innerPath: string): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath), { method: 'MKCOL' });
}

export async function uploadFile(owner: string, volume: string, innerPath: string, file: File | Blob): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath), {
    method: 'PUT',
    headers: { 'Content-Type': (file as File).type || 'application/octet-stream' },
    body: file,
  });
}

export async function deleteEntry(owner: string, volume: string, innerPath: string): Promise<void> {
  await davFetch(entryUrl(owner, volume, innerPath), { method: 'DELETE' });
}

export async function moveEntry(owner: string, volume: string, fromPath: string, toPath: string, overwrite = true): Promise<void> {
  const destination = new URL(entryUrl(owner, volume, toPath), globalThis.location.origin).href;
  await davFetch(entryUrl(owner, volume, fromPath), {
    method: 'MOVE',
    headers: { Destination: destination, Overwrite: overwrite ? 'T' : 'F' },
  });
}

export async function copyEntry(owner: string, volume: string, fromPath: string, toPath: string, overwrite = true): Promise<void> {
  const destination = new URL(entryUrl(owner, volume, toPath), globalThis.location.origin).href;
  await davFetch(entryUrl(owner, volume, fromPath), {
    method: 'COPY',
    headers: { Destination: destination, Overwrite: overwrite ? 'T' : 'F' },
  });
}

export function downloadUrl(owner: string, volume: string, innerPath: string): string {
  return entryUrl(owner, volume, innerPath);
}
