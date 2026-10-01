import type { DofsFs } from '@durable-dav/dav-store';
import { createdResponse, getParentPath, getRequestLockTokens, isSameOrDescendantPath, parseDestinationPath, renderMultiStatusFailures } from '@durable-dav/webdav';
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

/**
 * Does the client permit replacing the destination?
 *
 * RFC 4918 §10.6: `Overwrite = "Overwrite" ":" ("T" | "F")`. Only those two
 * tokens are legal. The previous test was `raw !== 'F'`, so `Overwrite: 0`,
 * `no`, or any garbage meant "yes" and silently destroyed the destination —
 * the wrong direction for a header whose only job is to prevent exactly that.
 * Absent means `T`. The ABNF literals are case-insensitive (RFC 5234 §2.3), so
 * `t`/`f` are accepted, but nothing else is.
 */
function isOverwriteAllowed(request: Request): boolean {
  const raw = request.headers.get('Overwrite');
  if (raw === null) return true;
  const token = raw.trim().toUpperCase();
  if (token === 'T') return true;
  if (token === 'F') return false;
  // Malformed: refuse the destructive reading rather than assume consent.
  return false;
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
  // Validated BEFORE the destination is removed. The order was reversed, so a
  // `COPY` of a collection with `Depth: 1` (rejected a few lines below) first
  // recursively deleted the destination subtree and *then* answered 400 — a
  // clean-looking rejection that had already destroyed data, with no way for
  // the client to know it should retry. Everything below this point mutates.
  if (srcStat.isDirectory) {
    const depth = request.headers.get('Depth') ?? 'infinity';
    if (depth !== '0' && depth !== 'infinity') return new Response('Bad Request', { status: 400 });
    if (destExists) {
      const removed = await removeDestination(
        destInner,
        new Request(request.url, { method: 'DELETE', headers: forwardLockHeaders(request) }),
      );
      if (removed) return removed;
    }
    try {
      dofs.mkdir(fsPathOf(destInner), { recursive: false });
    } catch {
      if (!destExists) return new Response('Conflict', { status: 409 });
    }
    repo.copyMeta(innerPath, destInner, true);
    if (depth === 'infinity') {
      // Collected rather than skipped. A child that fails to copy used to be
      // `continue`d, and the handler then answered 201/204 — so a quota-limited
      // COPY reported success with a silently truncated tree plus 0-byte
      // phantom files, and no `dav_nodes` row to match them. §9.8.3 requires a
      // 207 naming each failed resource.
      const failures: { href: string; status: string; description?: string }[] = [];
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
          } catch (error) {
            // Any partial bytes already written stay; `dofs.writeFile` refuses
            // oversize before mutating (see the pinned patch), so the common
            // failure here leaves a 0-byte stub. Reported, not hidden.
            failures.push({
              href: hrefOf(bases.hrefBase, dstChild, false),
              status: 'HTTP/1.1 507 Insufficient Storage',
              description: error instanceof Error ? error.message : undefined,
            });
            continue;
          }
        }
        repo.copyMeta(srcChild, dstChild, childStat.isDirectory);
      }
      if (failures.length > 0) {
        return new Response(renderMultiStatusFailures(failures), {
          status: 207,
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
      }
    }
    return destExists ? new Response(null, { status: 204 }) : createdResponse(hrefOf(bases.hrefBase, destInner, true));
  }
  if (destExists) {
    const removed = await removeDestination(
      destInner,
      new Request(request.url, { method: 'DELETE', headers: forwardLockHeaders(request) }),
    );
    if (removed) return removed;
  }
  try {
    const buf = dofs.read(fsPathOf(innerPath), {});
    await dofs.writeFile(fsPathOf(destInner), buf.slice(0), {});
  } catch (error) {
    // Not a blanket 404. `srcStat.exists` was confirmed above, so the source
    // cannot have vanished; the realistic throw is ENOSPC from the write, and
    // reporting that as "Not Found" told the client the *source* was gone (it
    // is not) while hiding the failure that had already removed the
    // destination. §11.5 has a status for exactly this.
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOSPC' ? new Response('Insufficient Storage', { status: 507 }) : new Response('Not Found', { status: 404 });
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
  // §9.9.2: "A client MUST NOT submit a Depth header on a MOVE on a collection
  // with any value but 'infinity'." `handleCopy` validated its own `Depth` and
  // this did not, so `MOVE /a` with `Depth: 0` silently performed a full
  // recursive move. Answering 400 is what deployed servers do, and it is the
  // only answer that tells the client its request was malformed.
  const depthHeader = request.headers.get('Depth');
  if (depthHeader !== null && depthHeader.trim().toLowerCase() !== 'infinity') {
    return new Response('Bad Request', { status: 400 });
  }
  // §9.9.4 lists "some resource within the source or destination collection" as
  // a 423 cause, so a locked *descendant* of the source blocks the move.
  // `handleDelete` already walks descendants for exactly this; MOVE used only
  // `assertLock`, which queries ancestors of the target, so a lock taken on
  // `/a/b.txt` did not stop another client relocating `/a` out from under it.
  if (srcStat.isDirectory) {
    // `requireRecursive` so a listing failure cannot read as "no locked
    // descendants" — see `WriteMethods.handleDelete` for the full reasoning.
    let descendants: string[];
    try {
      descendants = repo.requireRecursive(innerPath);
    } catch {
      return new Response('Internal Server Error', { status: 500 });
    }
    const tokens = getRequestLockTokens(request);
    for (const name of descendants) {
      const childInner = repo.childInner(innerPath, name);
      if (locks.activeTokensForPath(childInner, tokens).length > 0) {
        return new Response('Locked', { status: 423 });
      }
    }
  }
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
  // Locks are NOT carried across: RFC 4918 §7.6 — "A successful MOVE request on
  // a write locked resource MUST NOT move the write lock with the resource."
  // `renameNodeCascade` excludes `dav_locks` for that reason; this comment used
  // to cite §9.9 (the MOVE overview, which says nothing about locks) and
  // asserted the opposite of the rule.
  repo.renameCascade(innerPath, destInner);
  return destExists ? new Response(null, { status: 204 }) : createdResponse(hrefOf(bases.hrefBase, destInner, srcStat.isDirectory));
}

export { handleCopy, handleMove };
