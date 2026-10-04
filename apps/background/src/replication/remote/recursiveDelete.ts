import { RemoteUnavailableError } from '@durable-dav/backend-services/replication';
import { DELETE_FANOUT, MAX_REMOVE_DEPTH } from './davHttpProtocol';

/**
 * Recursive DELETE for a server that will not do it in one request.
 *
 * Its own module because it is the one part of the HTTP transport that *recurses*, and
 * therefore the one part with a termination argument to make. Everything it needs is two
 * callbacks — list the children, delete one resource — so it can be read and tested
 * without a server, a base URL, or an egress policy.
 *
 * The bounds themselves live in `davHttpProtocol` with the rest of the protocol
 * constants, so there is one place that says how this transport treats `DELETE`.
 */

type RemoveRecursiveOptions = {
  root: string;
  ifMatch: string | null;
  recursive: boolean;
  /**
  Direct children of a collection, in the remote's own coordinates.
  */
  listChildren: (path: string) => Promise<Array<{ path: string }>>;
  /**
   * Remove one resource; throws unless the server accepted it.
   *
   * A `404` is a success for a path this function just emptied or descended into, and
   * that is the caller's business, not this module's — `DELETE_SUCCESS` already says so.
   */
  deleteOne: (path: string, ifMatch: string | null) => Promise<void>;
};

/**
 * Depth-1 emulation. RFC 4918 §9.6.1 makes DELETE on a collection with
 * `Depth: infinity` optional and most servers refuse it, so a recursive delete
 * is built by emptying the subtree first. Bounded concurrency, and a partial
 * failure propagates: the caller must not record the deletion as done.
 */
async function removeRecursive(
  options: RemoveRecursiveOptions,
  path = options.root,
  depth = 0,
  visited = new Set<string>(),
): Promise<void> {
  // `depth` and `visited` are a hard stop on a misbehaving target. A server that answers
  // every `PROPFIND` with the same child would otherwise recurse without bound inside one
  // Durable Object invocation, taking the volume's isolate with it. Blowing the budget is
  // a reported failure, which the deletion gate already knows how to hold back.
  if (visited.has(path)) {
    throw new RemoteUnavailableError(`refusing to descend into ${path} again; the target reported a cycle`);
  }
  visited.add(path);
  if (depth > MAX_REMOVE_DEPTH) {
    throw new RemoteUnavailableError(`recursive delete exceeded ${MAX_REMOVE_DEPTH} levels at ${path}`);
  }
  if (!options.recursive) {
    await options.deleteOne(path, options.ifMatch);
    return;
  }

  const children = await options.listChildren(path);
  let index = 0;
  const workers = Array.from({ length: Math.min(DELETE_FANOUT, Math.max(1, children.length)) }, async () => {
    // The `while` bound is what makes the read safe: `index` is only advanced
    // after the check, so it is never out of range here.
    while (index < children.length) {
      const child = children[index];
      index += 1;
      // `ifMatch` is deliberately not propagated: RFC 7232 §3.1 makes `If-Match` a
      // conditional request, and a validator naming the *parent's* resource cannot apply
      // to a child. Passing it down would turn a recursive delete into a guaranteed 412.
      await removeRecursive(options, child.path, depth + 1, visited);
    }
  });
  await Promise.all(workers);
  await options.deleteOne(path, options.ifMatch);
}

export { removeRecursive };
