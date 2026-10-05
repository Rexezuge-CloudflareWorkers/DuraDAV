const DAV_CLASS = '1, 2';

const SUPPORT_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];

/**
 * Methods the DAV surface answers without changing the resource.
 *
 * This is the security-relevant list: `DavAuth.davAuthForVolume` takes the
 * negation as `needWrite` and refuses a write from a read-only credential, so
 * every caller must ask this module rather than keep its own copy. Two test
 * suites used to re-derive it, which meant a test could pass while the front
 * door it claimed to cover had already changed.
 *
 * Deliberately *not* the same set as `DAV_SAFE_METHODS` below: `PROPFIND` writes
 * nothing and `LOCK` writes a lock, so the two questions have two answers.
 */
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND'] as const;

/**
 * Methods that carry no request body.
 *
 * `PROPFIND` is absent — it is a body-carrying read. The front door forwards a
 * body and `duplex: 'half'` only when this says so, and streaming a body into a
 * request the runtime will not read is how a forwarded `PUT` loses its bytes.
 */
const DAV_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

/**
 * Does this method change the resource, and therefore require write authority?
 *
 * Used by the front door's read-only-credential gate and by every test that
 * exercises it.
 */
function requiresWrite(method: string): boolean {
  return !READ_METHODS.includes(method as (typeof READ_METHODS)[number]);
}

/**
 * May this method carry a request body?
 *
 * A different question from {@link requiresWrite}, answered from a different
 * list: `PROPFIND` writes nothing and needs a body, while `GET` writes nothing
 * and must not have one. Collapsing the two is the mistake this pair exists to
 * prevent.
 */
function allowsBody(method: string): boolean {
  return !DAV_SAFE_METHODS.includes(method as (typeof DAV_SAFE_METHODS)[number]);
}

const CORS_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'depth',
  'overwrite',
  'destination',
  'range',
  'if',
  'lock-token',
  'timeout',
].join(', ');

const CORS_EXPOSE_HEADERS = [
  'content-type',
  'content-length',
  'dav',
  'etag',
  'last-modified',
  'location',
  'date',
  'content-range',
  'lock-token',
].join(', ');

/**
 * CORS for the WebDAV plane.
 *
 * Why an allow-list rather than reflecting `Origin`: the previous
 * implementation echoed whatever origin asked, so *any* website on the
 * internet could read a WebDAV response — including a private volume's
 * listings — for any request the browser was willing to send. It also omitted
 * `Vary: Origin`, which is the textbook setup for a shared cache serving one
 * origin's response to another.
 *
 * The allow-list is derived from `SITE_URL`, which is already a required
 * deployment variable. When it is unset the worker falls back to same-origin
 * only: a browser sends `Origin` on every cross-origin request, so "no
 * `Origin`, or an `Origin` matching the request host" is exactly the
 * same-origin case.
 */

/**
Origins permitted to read WebDAV responses, or `null` for same-origin only.
*/
function allowedOrigins(siteUrl: string | null | undefined): readonly string[] {
  if (!siteUrl) return [];
  try {
    return [new URL(siteUrl).origin];
  } catch {
    return [];
  }
}

function applyCors(response: Response, request: Request, siteUrl?: string | null): Response {
  // DO RPC responses arrive with immutable headers — rebuild instead of mutating.
  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get('Origin');
  const allowed = allowedOrigins(siteUrl);

  if (requestOrigin === null) {
    // Same-origin or a non-browser client: nothing to negotiate.
    headers.delete('Access-Control-Allow-Origin');
  } else if (allowed.includes(requestOrigin)) {
    // Echo the origin verbatim only when it is allow-listed.
    headers.set('Access-Control-Allow-Origin', requestOrigin);
    // Required whenever the response varies by `Origin`, so a shared cache
    // cannot hand one origin's response to another.
    headers.set('Vary', 'Origin');
  } else {
    // Omit the header entirely, which is what makes the browser block the read.
    // It was previously set to `''` and then deleted, so the allow-list check
    // and the delete both had to be right for the request to be refused.
    headers.delete('Access-Control-Allow-Origin');
  }

  headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
  headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  // No cookies or HTTP-auth are ever used for WebDAV, so credentialed CORS is
  // never appropriate here.
  headers.set('Access-Control-Allow-Credentials', 'false');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function createdResponse(resourceHref: string, body: BodyInit | null = '', headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Location', resourceHref);
  return new Response(body, { status: 201, headers: responseHeaders });
}

/**
 * An RFC 4918 §16 `DAV:error` body.
 *
 * The DAV protocol has a defined way to say *why* a request failed — a status
 * element naming a precondition or postcondition code — and a client that reads
 * it can tell "you are not allowed to do this" from "this server is broken".
 * A bare `new Response('Forbidden', { status: 403 })` throws that away.
 *
 * `condition` is a local name inside the `DAV:` namespace, emitted only when
 * given: RFC 4918 requires a `responsedescription` sibling, but inventing a
 * human-readable string here would mean a second set of translated messages on
 * a path that has none, so the wire body stays a bare code.
 */
function davErrorResponse(status: number, condition?: string, headers: HeadersInit = {}): Response {
  const body = condition
    ? `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:${condition}/></D:error>`
    : '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"/>';
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/xml; charset=utf-8');
  return new Response(body, { status, headers: responseHeaders });
}

export {
  DAV_CLASS,
  SUPPORT_METHODS,
  READ_METHODS,
  DAV_SAFE_METHODS,
  requiresWrite,
  allowsBody,
  applyCors,
  createdResponse,
  allowedOrigins,
  davErrorResponse,
};
