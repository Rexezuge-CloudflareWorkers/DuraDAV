import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readPageParams, stripPageParams } from '../apps/api/src/workers/routes/davPageParams';
import { applySecurityHeaders, isSensitiveJsonPath, SECURITY_HEADERS, securityHeaders } from '../apps/api/src/middleware/securityHeaders';
import { BaseRoute } from '../apps/api/src/endpoints/IBaseRoute';

/**
 * The API front door's pure routing/response layer.
 *
 * `apps/api/src/workers/routes/*` and `apps/api/src/middleware/*` sat at 0%
 * statement coverage even though two of them are security boundaries: the paging
 * opt-in (only this plane may set `X-Dav-Page*`) and the header policy. The DO
 * integration suite exercises them end-to-end; these pin the decisions
 * themselves, which an end-to-end test can only observe indirectly.
 */

type Ctx = Parameters<typeof applySecurityHeaders>[0];

describe('browser-plane paging params', () => {
  it('does not opt in when neither parameter is present', () => {
    // Returning `{page: null, limit: null}` here would opt every DAV client and
    // share link into paging, which RFC 4918 §9.1 has no concept of.
    expect(readPageParams(new URL('https://h/user/volumes/o/v/files/x'))).toBeNull();
    expect(readPageParams(new URL('https://h/user/volumes/o/v/files/x?other=1'))).toBeNull();
  });

  it('opts in on either parameter alone', () => {
    expect(readPageParams(new URL('https://h/x?page=2'))).toEqual({ page: '2', limit: null });
    expect(readPageParams(new URL('https://h/x?limit=50'))).toEqual({ page: null, limit: '50' });
  });

  it('passes values through unvalidated, because the DO is the enforcement point', () => {
    // Clamping here would duplicate `MAX_PAGE_SIZE`; the DO owns it. What must
    // not happen is silent coercion — `?limit=abc` has to reach the DO as-is so
    // it can be answered with a value the pager can display.
    expect(readPageParams(new URL('https://h/x?page=-4&limit=99999'))).toEqual({ page: '-4', limit: '99999' });
    expect(readPageParams(new URL('https://h/x?page=abc'))).toEqual({ page: 'abc', limit: null });
    // An empty value is a real case: this URL is built by code that omits empty
    // params, and `?page=` must not read as absent.
    expect(readPageParams(new URL('https://h/x?page=&limit='))).toEqual({ page: '', limit: '' });
  });

  it('strips only the two paging params and preserves the rest', () => {
    const stripped = stripPageParams(new URL('https://h/x?page=2&limit=50&path=a/b&backend=https://b&q=1'));
    expect(stripped.searchParams.get('page')).toBeNull();
    expect(stripped.searchParams.get('limit')).toBeNull();
    expect(stripped.searchParams.get('path')).toBe('a/b');
    expect(stripped.searchParams.get('q')).toBe('1');
    expect(stripped.searchParams.get('backend')).toBe('https://b');
  });

  it('does not mutate the input URL', () => {
    const url = new URL('https://h/x?page=2');
    stripPageParams(url);
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('tolerates absent params when stripping', () => {
    const stripped = stripPageParams(new URL('https://h/x'));
    expect(stripped.search).toBe('');
  });

  it('does not confuse a param whose name merely starts with page', () => {
    // `pageSize` is not `page`; deleting it would drop a caller's own parameter.
    const stripped = stripPageParams(new URL('https://h/x?pageSize=25&limitX=9'));
    expect(stripped.searchParams.get('pageSize')).toBe('25');
    expect(stripped.searchParams.get('limitX')).toBe('9');
  });
});

describe('security headers', () => {
  function runApp(build: (app: Hono) => void, url: string): Promise<Response> {
    const app = new Hono();
    app.use('*', securityHeaders());
    build(app);
    return Promise.resolve(app.request(url, {} as never));
  }

  it('applies the baseline set to every response', async () => {
    const res = await runApp((a) => a.get('/x', (c) => c.json({ ok: true })), 'https://h/x');
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(key)).toBe(value);
    }
  });

  it('adds a CSP only to an HTML document', async () => {
    const html = await runApp((a) => a.get('/x', (c) => c.html('<h1>hi</h1>')), 'https://h/x');
    const csp = html.headers.get('Content-Security-Policy') ?? '';
    // The SPA ships inline scripts/styles, so `unsafe-inline` for those two is
    // required; `frame-ancestors 'none'` and `object-src 'none'` are the parts
    // that must not be negotiable.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");

    const json = await runApp((a) => a.get('/x', (c) => c.json({})), 'https://h/x');
    expect(json.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('marks every /user/ response no-store', async () => {
    for (const path of ['/user/me', '/user/volumes', '/user/volumes/o/v/credentials']) {
      expect(isSensitiveJsonPath(path)).toBe(true);
      const res = await runApp((a) => a.get(path, (c) => c.json({})), `https://h${path}`);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('leaves a public DAV read cacheable', () => {
    // The WebDAV plane owns its own `Cache-Control`; overriding it here would
    // defeat the read cache the front door exists to populate.
    expect(isSensitiveJsonPath('/alice/photos/notes.txt')).toBe(false);
    expect(isSensitiveJsonPath('/')).toBe(false);
  });

  it('does not let a handler Cache-Control survive on a /user/ path', async () => {
    const res = await runApp(
      (a) => a.get('/user/volumes', (c) => c.json({ volumes: [] }, 200, { 'Cache-Control': 'public, max-age=60' })),
      'https://h/user/volumes',
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends HSTS over HTTPS only', async () => {
    const secure = await runApp((a) => a.get('/x', (c) => c.json({})), 'https://h/x');
    expect(secure.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    // `new URL(...).protocol` is what gates it. Sending HSTS over plain HTTP
    // risks local pinning and is ignored by browsers anyway.
    const plain = await runApp((a) => a.get('/x', (c) => c.json({})), 'http://localhost/x');
    expect(plain.headers.get('Strict-Transport-Security')).toBeNull();
    expect(plain.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('never fails a request when header application throws', async () => {
    // Applied *after* `next()`, so a throw here would replace a good response
    // with a 500. Guarded, and asserted.
    const throwing = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await runApp((a) => a.get('/x', (c) => c.json({ ok: true })), 'https://h/x');
    expect(res.status).toBe(200);
    throwing.mockRestore();
  });
});

describe('BaseRoute error mapping', () => {
  function ctxFor(url: string): Ctx {
    const app = new Hono();
    app.get('*', (c) => c.json({}));
    void app.request(url, {} as never);
    return {
      req: { url, header: () => undefined },
      res: new Response(),
      header: () => undefined,
      json: () => new Response(),
    } as unknown as Ctx;
  }

  it('maps status codes to AWS Exception.Type through the registry', () => {
    expect(BaseRoute.toErrorType(400)).toBe('BadRequest');
    expect(BaseRoute.toErrorType(401)).toBe('Unauthorized');
    expect(BaseRoute.toErrorType(403)).toBe('Forbidden');
    expect(BaseRoute.toErrorType(404)).toBe('NotFound');
    expect(BaseRoute.toErrorType(409)).toBe('Conflict');
    expect(BaseRoute.toErrorType(413)).toBe('PayloadTooLarge');
    expect(BaseRoute.toErrorType(429)).toBe('RateLimited');
  });

  it('falls back to InternalServerError for an unmapped or absurd status', () => {
    // No `default:` branch, so an unlisted code cannot accidentally inherit
    // another entry's Type.
    expect(BaseRoute.toErrorType(418)).toBe('InternalServerError');
    expect(BaseRoute.toErrorType(0)).toBe('InternalServerError');
    expect(BaseRoute.toErrorType(999)).toBe('InternalServerError');
  });

  it('builds the wire envelope', () => {
    const json = vi.fn((_body: unknown, status: number) => new Response('{}', { status }));
    const c = { json } as unknown as Ctx;
    const res = BaseRoute.jsonError(c, 'nope', 400);
    expect(json).toHaveBeenCalledWith({ Exception: { Type: 'BadRequest', Message: 'nope' } }, 400);
    expect(res.status).toBe(400);
  });

  it('answers 413 for an oversized body and 400 for a malformed one', () => {
    // Six call sites wrote this pair by hand and had drifted from the registry
    // that decides the Type, so it is centralised in `rejectUnreadableBody`.
    const json = vi.fn((_body: unknown, status: number) => new Response('{}', { status }));
    const c = { json } as unknown as Ctx;
    expect(BaseRoute.rejectUnreadableBody(c, { malformed: false, oversized: true })?.status).toBe(413);
    expect(BaseRoute.rejectUnreadableBody(c, { malformed: true, oversized: false })?.status).toBe(400);
    // A body that parsed is not a rejection at all.
    expect(BaseRoute.rejectUnreadableBody(c, { malformed: false, oversized: false })).toBeNull();
  });

  it('masks an untyped error as a localized 500 and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = BaseRoute.toErrorResponse(ctxFor('https://h/user/me'), new Error('internal detail: db password hunter2'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { Exception: { Type: string; Message: string } };
    expect(body.Exception.Type).toBe('InternalServerError');
    // The cause must not reach the client.
    expect(body.Exception.Message).not.toContain('hunter2');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

/**
 * A context stub that reports a specific `Accept-Language`, so `resolveLocale`
 * can be observed rather than inferred.
 */
function localizedCtx(language: string | undefined): Ctx {
  // `resolveLocale` reads `c.req.header(...)`, so the stub has to answer there.
  // (An earlier version put `header` on `c` itself; `resolveLocale`'s try/catch
  // turned the resulting TypeError into `'en'`, and every locale assertion
  // failed for a reason that had nothing to do with the locale.)
  const req = {
    url: 'https://h/x',
    header: (name: string): string | undefined =>
      language !== undefined && name.toLowerCase() === 'accept-language' ? language : undefined,
  };
  return { req, res: new Response(), json: () => new Response() } as unknown as Ctx;
}

describe('BaseRoute Accept-Language resolution', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

  /**
   * The `Exception.Message` a 500 carries for a given `Accept-Language`.
   */
  async function messageFor(language: string | undefined): Promise<string> {
    const body = await BaseRoute.toErrorResponse(localizedCtx(language), new Error('boom')).json();
    return (body as { Exception: { Message: string } }).Exception.Message;
  }

  it('localizes the 500 per the requested language', async () => {
    const spy = quiet();
    // `resolveLocale` is private, so this is observed through the only thing it
    // affects. English and German genuinely differ, so a header that is ignored
    // is distinguishable from one that is honoured.
    expect(await messageFor(undefined)).toBe('Internal Server Error.');
    expect(await messageFor('de')).toBe('Interner Serverfehler.');
    spy.mockRestore();
  });

  it('takes the first language and ignores a quality suffix', async () => {
    const spy = quiet();
    for (const header of ['de', 'de-DE', 'de-DE;q=0.9', 'de;q=0.8, en;q=0.9']) {
      expect(await messageFor(header)).toBe('Interner Serverfehler.');
    }
    spy.mockRestore();
  });

  it('falls back to English for an unknown or malformed tag', async () => {
    const spy = quiet();
    for (const header of ['xx', '', ' '.repeat(3), ';;;']) {
      expect(await messageFor(header)).toBe('Internal Server Error.');
    }
    spy.mockRestore();
  });

  it('still answers 500 for every locale, never the raw cause', async () => {
    const spy = quiet();
    for (const header of [undefined, 'de', 'ja', 'xx']) {
      const res = BaseRoute.toErrorResponse(localizedCtx(header), new Error('secret: hunter2'));
      expect(res.status).toBe(500);
      expect((await res.json() as { Exception: { Message: string } }).Exception.Message).not.toContain('hunter2');
    }
    spy.mockRestore();
  });
});
