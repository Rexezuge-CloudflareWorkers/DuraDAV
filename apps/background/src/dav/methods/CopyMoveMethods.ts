import type { DofsFs } from '@durable-dav/dav-store';
import { createdResponse, getParentPath, isSameOrDescendantPath, parseDestinationPath } from '@durable-dav/webdav';
import { MAX_PATH_DEPTH, fsPathOf, hrefOf, isValidInnerPath, stripBase } from '../DavContext';
import type { DavBases } from '../DavContext';
import type { DavLockGuard } from '../DavLockGuard';
import type { DavRepository } from '../DavRepository';

function forwardLockHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const key of ['If', 'Lock-Token']) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

// `Overwrite` is case-insensitive per RFC 4918 (`T`/`F`); default is `T`.
function isOverwriteAllowed(request: Request): boolean {
  const raw = request.headers.get('Overwrite');
  return raw === null || raw.trim().toUpperCase() !== 'F';
}

type DestinationResolution = { ok: true; destInner: string } | { ok: false; response: Response };

/**
 * Resolve and validate the `Destination` header for COPY/MOVE.
 *
 * Single source of truth — the preamble was duplicated verbatim in both
 * handlers, which is how the two drifted apart on the checks below.
 *
 * Three things are enforced here that neither handler did on its own:
 *
 * 1. `isValidInnerPath(destInner)` plus the `stripBase` contract. `Destination`
 *    is fully client-controlled. The front door now canonicalises it to the
 *    `/owner/volume` form (see `apps/api`'s `davDestination`) and rejects a
 *    dot-segment on the raw header, so an escape attempt is refused before it
 *    reaches here. Both checks below are kept as the backstop they now are:
 *    `stripBase` still refuses a non-base-prefixed single-segment path — which
 *    is what the WHATWG parser's `%2e%2e` normalisation used to collapse to —
 *    and `isValidInnerPath` still rejects any `.`/`..` that survived decoding.
 * 2. Self/descendant rejection. `isSameOrDescendantPath` covers equality, so
 *    the question is asked once. The volume root is deliberately *not* a
 *    special case: its descendants are every path in the bucket, and RFC 4918
 *    §9.8.3 forbids copying a collection into itself or a descendant — so a
 *    volume root genuinely has no legal in-volume COPY destination.
 * 3. A depth cap, so a pathological destination cannot drive an unbounded
 *    path walk downstream.
 */
function resolveDestination(request: Request, pathBase: string, srcInner: string): DestinationResolution {
  const bad = { ok: false, response: new Response('Bad Request', { status: 400 }) } as const;

  const destHeader = request.headers.get('Destination');
  if (!destHeader) return bad;
  const destFull = parseDestinationPath(destHeader, request.url);
  if (destFull === null) return bad;
  // Always the *path* base, in both href modes: the front door has already
  // rewritten a `root`-mode client's root-relative href into `/owner/volume/...`,
  // so the DO only ever sees one destination shape.
  const destInner = stripBase(destFull, pathBase);
  if (destInner === null) return bad;
  if (!isValidInnerPath(destInner)) return bad;
  if (destInner.split('/').length > MAX_PATH_DEPTH) return bad;
  return isSameOrDescendantPath(srcInner, destInner) ? bad : { ok: true, destInner };
}

async function handleCopy(
  request: Request,
  innerPath: string,
  bases: DavBases,
  repo: DavRepository,
  locks: DavLockGuard,
  dofs: DofsFs,
  removeDestination: (destInner: string, overwriteRequest: Request) => Promise<Response | null>,
): Promise<Response> {
  const destination = resolveDestination(request, bases.pathBase, innerPath);
  if (!destination.ok) return destination.response;
  const { destInner } = destination;
  const locked = locks.assertLock(request, destInner);
  if (locked) return locked;
  const srcStat = repo.statInner(innerPath);
  if (!srcStat.exists) return new Response('Not Found', { status: 404 });
  const destParent = getParentPath(destInner);
  if (destParent !== '' && !repo.statInner(destParent).isDirectory) return new Response('Conflict', { status: 409 });
  const overwrite = isOverwriteAllowed(request);
  const destExists = repo.statInner(destInner).exists;
  if (!overwrite && destExists) return new Response('Precondition Failed', { status: 412 });
  if (destExists) {
    const removed = await removeDestination(
      destInner,
      new Request(request.url, { method: 'DELETE', headers: forwardLockHeaders(request) }),
    );
    if (removed) return removed;
  }
  if (srcStat.isDirectory) {
    const depth = request.headers.get('Depth') ?? 'infinity';
    if (depth !== '0' && depth !== 'infinity') return new Response('Bad Request', { status: 400 });
    try {
      dofs.mkdir(fsPathOf(destInner), { recursive: false });
    } catch {
      if (!destExists) return new Response('Conflict', { status: 409 });
    }
    repo.copyMeta(innerPath, destInner, true);
    if (depth === 'infinity') {
      for (const name of repo.listRecursive(innerPath)) {
        const srcChild = repo.childInner(innerPath, name);
        const rel = srcChild.slice(innerPath.length + 1);
        const dstChild = `${destInner}/${rel}`;
        const childStat = repo.statInner(srcChild);
        if (childStat.isDirectory) {
          try {
            dofs.mkdir(fsPathOf(dstChild), { recursive: false });
          } catch {
            // Best-effort; metadata copy below still records the collection.
          }
        } else {
          try {
            const buf = dofs.read(fsPathOf(srcChild), {});
            await dofs.writeFile(fsPathOf(dstChild), buf.slice(0), {});
          } catch {
            continue;
          }
        }
        repo.copyMeta(srcChild, dstChild, childStat.isDirectory);
      }
    }
    return destExists ? new Response(null, { status: 204 }) : createdResponse(hrefOf(bases.hrefBase, destInner, true));
  }
  try {
    const buf = dofs.read(fsPathOf(innerPath), {});
    await dofs.writeFile(fsPathOf(destInner), buf.slice(0), {});
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  repo.copyMeta(innerPath, destInner, false);
  return destExists ? new Response(null, { status: 204 }) : createdResponse(hrefOf(bases.hrefBase, destInner, false));
}

async function handleMove(
  request: Request,
  innerPath: string,
  bases: DavBases,
  repo: DavRepository,
  locks: DavLockGuard,
  dofs: DofsFs,
  deleteForMove: (destInner: string, req: Request) => Promise<Response | null>,
): Promise<Response> {
  const destination = resolveDestination(request, bases.pathBase, innerPath);
  if (!destination.ok) return destination.response;
  const { destInner } = destination;
  const srcLock = locks.assertLock(request, innerPath);
  if (srcLock) return srcLock;
  const dstLock = locks.assertLock(request, destInner);
  if (dstLock) return dstLock;
  const srcStat = repo.statInner(innerPath);
  if (!srcStat.exists) return new Response('Not Found', { status: 404 });
  const destParent = getParentPath(destInner);
  if (destParent !== '' && !repo.statInner(destParent).isDirectory) return new Response('Conflict', { status: 409 });
  const overwrite = isOverwriteAllowed(request);
  const destExists = repo.statInner(destInner).exists;
  if (!overwrite && destExists) return new Response('Precondition Failed', { status: 412 });
  if (destExists) {
    const removed = await deleteForMove(destInner, new Request(request.url, { method: 'DELETE', headers: forwardLockHeaders(request) }));
    if (removed) return removed;
  }
  try {
    dofs.rename(fsPathOf(innerPath), fsPathOf(destInner));
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }
  // MOVE preserves locks (RFC 4918 §9.9); COPY does not.
  repo.renameCascade(innerPath, destInner);
  return destExists ? new Response(null, { status: 204 }) : createdResponse(hrefOf(bases.hrefBase, destInner, srcStat.isDirectory));
}

export { handleCopy, handleMove };
