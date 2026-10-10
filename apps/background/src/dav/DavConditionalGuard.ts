/**
 * RFC 7232 conditional-request evaluation for WebDAV.
 *
 * Why this exists: the server emitted `ETag` on GET but never *read*
 * `If-Match`/`If-None-Match`/`If-Modified-Since` (only the KV read cache did,
 * and only on a hit — a cache miss always round-tripped and returned 200).
 * Without it, `PUT` with `If-Match: "stale"` overwrote anyway, defeating the
 * lost-update protection these headers exist for, and Finder/davfs2's
 * create-only `PUT` (`If-None-Match: *`) always succeeded.
 */
import { getIfHeaderEtags, weakEtagValue } from '@durable-dav/webdav';

class DavConditionalGuard {
  /**
   * Evaluate the `If-Match` / `If-None-Match` / `If-Unmodified-Since` trio.
   * Returns a `Response` when the precondition fails, otherwise `null`.
   *
   * Precedence is fixed by RFC 9110 §13.2.2: `If-Match` is evaluated first,
   * then `If-Unmodified-Since` (only when `If-Match` is absent), then
   * `If-None-Match`, then `If-Modified-Since` (only when `If-None-Match` is
   * absent and only for a read). Each step is *skipped by its predecessor*, not
   * by a short-circuit out of the whole evaluation — a satisfied `If-Match`
   * continues on to the later three.
   *
   * Weak comparison is used for `If-Match` and strong comparison for
   * `If-None-Match` only if the header says `W/`; in practice WebDAV clients
   * echo back the strong ETag the server sent, so `W/` prefixes are tolerated
   * on both sides rather than causing spurious 412s.
   */
  public check(request: Request, state: { etag: string | null; mtime: number | null }, opts: { forRead?: boolean } = {}): Response | null {
    const { etag, mtime } = state;

    const ifMatch = request.headers.get('If-Match');
    if (ifMatch !== null) {
      if (ifMatch.trim() === '*') {
        // `*` matches any current representation. A resource that does not
        // exist has no representation, so the condition fails.
        if (etag === null) return preconditionFailed('If-Match');
      } else if (etag === null || !matchesEtagList(ifMatch, etag)) {
        return preconditionFailed('If-Match');
      }
      // A *satisfied* `If-Match` must fall through, not short-circuit. It only
      // skips `If-Unmodified-Since`; `If-None-Match`, `If` and
      // `If-Modified-Since` are still evaluated. Returning here meant
      // `If-Match: "<current>"` + `If-None-Match: *` answered 200 with a body
      // on a read and overwrote on a write, where RFC 9110 §13.2.2 requires
      // 304 and 412 — and it contradicted the precedence stated above.
    }

    const ifUnmodified = request.headers.get('If-Unmodified-Since');
    if (ifMatch === null && ifUnmodified !== null && mtime !== null) {
      const since = Date.parse(ifUnmodified);
      // Only applies when the client sent a valid date; an unparseable value
      // is ignored per RFC 9110 §13.1.3.
      if (Number.isFinite(since) && Math.floor(mtime / 1000) * 1000 > since) {
        return preconditionFailed('If-Unmodified-Since');
      }
    }

    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch !== null) {
      const wildcard = ifNoneMatch.trim() === '*';
      const matched = !wildcard && etag !== null && matchesEtagList(ifNoneMatch, etag);
      if (wildcard || matched) {
        // For a read the correct answer is 304; for a write, 412.
        return opts.forRead === true
          ? new Response(null, { status: 304, headers: etag ? { ETag: etag } : {} })
          : preconditionFailed('If-None-Match');
      }
    }

    // RFC 4918 §10.4.4 entity-tag conditions carried in the `If` header, e.g.
    // `If: (["weak-etag"])`. `hasAlwaysFalseIfCondition` has already rejected
    // headers the grammar parser could not read, so anything reaching here is
    // well-formed. A list is satisfied when any positive condition matches;
    // `Not` conditions invert.
    const ifEtags = getIfHeaderEtags(request);
    if (ifEtags.length > 0) {
      const satisfied = ifEtags.some((condition) => {
        const hit = etag !== null && matchesEtagList(condition.etag, etag);
        return condition.negated ? !hit : hit;
      });
      if (!satisfied) return preconditionFailed('If');
    }

    const ifModifiedSince = opts.forRead === true ? request.headers.get('If-Modified-Since') : null;
    if (ifNoneMatch === null && ifModifiedSince !== null && mtime !== null) {
      const since = Date.parse(ifModifiedSince);
      if (Number.isFinite(since) && Math.floor(mtime / 1000) * 1000 <= since) {
        return new Response(null, { status: 304, headers: etag ? { ETag: etag } : {} });
      }
    }

    return null;
  }
}

function preconditionFailed(header: string): Response {
  return new Response(`Precondition Failed: ${header}`, { status: 412 });
}

/**
Compare an `If-Match`/`If-None-Match` list against the current ETag.

Both sides go through `weakEtagValue`: RFC 9110 §13.1.2 defines `If-None-Match`
as a weak comparison, so a `W/"x"` header must match a stored `"x"`. The
validator we mint is already unquoted, which is why the quotes are left alone
here — see `weakEtagValue`.
*/
function matchesEtagList(headerValue: string, etag: string): boolean {
  const target = weakEtagValue(etag);
  return headerValue
    .split(',')
    .map((part) => weakEtagValue(part))
    .includes(target);
}

export { DavConditionalGuard };
