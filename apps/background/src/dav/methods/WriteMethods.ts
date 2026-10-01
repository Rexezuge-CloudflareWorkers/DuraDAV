/* eslint-disable @typescript-eslint/require-await -- WebDAV write handlers keep async for uniform dispatch. */
import type { DofsFs } from '@durable-dav/dav-store';
import { MAX_XML_BODY_BYTES, getParentPath, getRequestLockTokens, readCappedBody } from '@durable-dav/webdav';
import { fsPathOf } from '../DavContext';
import { DavConditionalGuard } from '../DavConditionalGuard';
import type { DavLockGuard } from '../DavLockGuard';
import type { DavRepository } from '../DavRepository';

async function handlePut(
  request: Request,
  innerPath: string,
  repo: DavRepository,
  locks: DavLockGuard,
  dofs: DofsFs,
  maxFileBytes: number,
): Promise<Response> {
  // The resource type comes from the request target, not `isDirectory`: the
  // request *path* trailing in `/` names a collection, which PUT refuses
  // (§9.7.2 — 405 is defined for an existing collection), and the root itself is
  // a collection too, so both answer 405.
  //
  // `new URL(request.url).pathname`, not `request.url.endsWith('/')`: the
  // latter tests the whole URL including the query string, so
  // `PUT /a/notes.txt?next=/` — an ordinary file with a query parameter ending
  // in a slash — was answered 405. A trailing slash is a property of the path
  // (§8.3), not of the URL, and `DavVolumeWorker` already builds this `URL` for
  // addressing, so the two can no longer disagree.
  if (innerPath === '' || new URL(request.url).pathname.endsWith('/')) return new Response('Method Not Allowed', { status: 405 });
  const locked = locks.assertLock(request, innerPath);
  if (locked) return locked;
  const parent = getParentPath(innerPath);
  if (parent !== '' && !repo.statInner(parent).isDirectory) return new Response('Conflict', { status: 409 });
  const existing = repo.statInner(innerPath);
  if (existing.exists && existing.isDirectory) return new Response('Method Not Allowed', { status: 405 });
  // RFC 7232 §6: without this, `If-Match: "stale"` overwrote anyway (lost
  // update) and Finder/davfs2's create-only `If-None-Match: *` always
  // succeeded instead of answering 412.
  const previous = repo.readMeta(innerPath);
  const conditional = new DavConditionalGuard().check(request, { etag: previous.etag ?? null, mtime: previous.mtime ?? null });
  if (conditional) return conditional;
  // Streaming cap, not a post-hoc check: an oversize body is refused without
  // ever being fully buffered.
  const body = await readCappedBody(request, maxFileBytes);
  if (!body.ok) return new Response('Payload Too Large', { status: 413 });
  const bytes = new Uint8Array(body.bytes);
  try {
    await dofs.writeFile(fsPathOf(innerPath), bytes.slice().buffer, {});
  } catch {
    return new Response('Insufficient Storage', { status: 507 });
  }
  const contentType = request.headers.get('Content-Type') ?? 'application/octet-stream';
  const now = Date.now();
  // `previous` was read before the write for the precondition check; reuse it
  // so `crtime` is preserved across an overwrite without a second query.
  repo.upsertFileNode(innerPath, contentType, `"${bytes.byteLength.toString(16)}-${now.toString(16)}"`, now, previous.crtime ?? now);
  return existing.exists ? new Response(null, { status: 204 }) : new Response('', { status: 201 });
}

async function handleDelete(
  request: Request,
  innerPath: string,
  repo: DavRepository,
  locks: DavLockGuard,
  dofs: DofsFs,
): Promise<Response> {
  if (innerPath === '') return new Response('Forbidden', { status: 403 });
  const st = repo.statInner(innerPath);
  if (!st.exists) return new Response('Not Found', { status: 404 });
  const locked = locks.assertLock(request, innerPath);
  if (locked) return locked;
  if (st.isDirectory) {
    // `requireRecursive`, not `listRecursive`: this loop is a *lock check*, and
    // `listRecursive` answers `[]` on any listing failure — so a transient
    // storage error made "I could not enumerate" indistinguishable from "nothing
    // is locked", and the recursive delete below then removed a locked file.
    // This is the only lock check in the DO that could fail open; it now cannot.
    let descendants: string[];
    try {
      descendants = repo.requireRecursive(innerPath);
    } catch {
      // Fail closed: refuse rather than delete a subtree whose locks are unknown.
      return new Response('Internal Server Error', { status: 500 });
    }
    const tokens = getRequestLockTokens(request);
    for (const name of descendants) {
      const childInner = repo.childInner(innerPath, name);
      if (locks.activeTokensForPath(childInner, tokens).length > 0) {
        return new Response('Locked', { status: 423 });
      }
    }
    try {
      dofs.rmdir(fsPathOf(innerPath), { recursive: true });
    } catch {
      return new Response('Internal Server Error', { status: 500 });
    }
    repo.deleteCascade(innerPath);
    return new Response(null, { status: 204 });
  }
  try {
    dofs.unlink(fsPathOf(innerPath));
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  repo.deleteCascade(innerPath);
  return new Response(null, { status: 204 });
}

async function handleMkcol(request: Request, innerPath: string, repo: DavRepository, locks: DavLockGuard, dofs: DofsFs): Promise<Response> {
  // RFC 4918 §9.3.1: a body makes the request unsupported. `request.clone()`
  // used to tee the stream so the full payload was buffered twice just to
  // discover it was non-empty.
  const probe = await readCappedBody(request, MAX_XML_BODY_BYTES);
  if (!probe.ok) return new Response('Payload Too Large', { status: 413 });
  if (probe.bytes.byteLength > 0) return new Response('Unsupported Media Type', { status: 415 });
  if (innerPath === '') return new Response('Method Not Allowed', { status: 405 });
  const locked = locks.assertLock(request, innerPath);
  if (locked) return locked;
  if (repo.statInner(innerPath).exists) return new Response('Method Not Allowed', { status: 405 });
  const parent = getParentPath(innerPath);
  if (parent !== '' && !repo.statInner(parent).isDirectory) return new Response('Conflict', { status: 409 });
  try {
    dofs.mkdir(fsPathOf(innerPath), { recursive: false });
  } catch {
    return new Response('Conflict', { status: 409 });
  }
  repo.upsertCollectionNode(innerPath, Date.now());
  return new Response('', { status: 201 });
}

export { handlePut, handleDelete, handleMkcol };
