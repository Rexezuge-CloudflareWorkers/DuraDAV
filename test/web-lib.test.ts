import { describe, expect, it, vi } from 'vitest';
import { BackendError, apiGet, getBackendErrorStatus, getBackendErrorType, readJson } from '~/lib/api';
import { toLocalizedErrorMessage } from '~/lib/backendErrors';
import { formatBytes, formatExpiryTimestamp } from '~/lib/format';

describe('backend error extraction', () => {
  const json = (body: unknown, status = 400): Response => Response.json(body, { status, headers: { 'Content-Type': 'application/json' } });

  it('reads the AWS envelope', async () => {
    const error = await readJson(json({ Exception: { Type: 'NotFound', Message: 'gone' } }, 404)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendError);
    expect(getBackendErrorType(error)).toBe('NotFound');
    expect(getBackendErrorStatus(error)).toBe(404);
    expect((error as BackendError).message).toBe('gone');
  });

  it('reads the legacy shape', async () => {
    const error = await readJson(json({ error: 'BadRequest', message: 'bad' })).catch((e: unknown) => e);
    expect(getBackendErrorType(error)).toBe('BadRequest');
    expect((error as BackendError).message).toBe('bad');
  });

  it('surfaces a plain-text body', async () => {
    await expect(readJson(new Response('boom', { status: 502 }))).rejects.toMatchObject({
      message: 'boom',
      status: 502,
    });
  });

  it('falls back to the status line for an empty error body', async () => {
    await expect(readJson(new Response('', { status: 500 }))).rejects.toMatchObject({ message: 'HTTP 500' });
  });

  it('returns undefined for 204 instead of throwing SyntaxError', async () => {
    // `response.json()` threw `Unexpected end of JSON input` here, and because
    // that is not a BackendError a successful credential revoke reported
    // "Failed To Revoke Credential".
    await expect(readJson(new Response(null, { status: 204 }))).resolves.toBeUndefined();
  });

  it('returns undefined for an empty 200 body', async () => {
    await expect(readJson(new Response('', { status: 200 }))).resolves.toBeUndefined();
  });

  it('raises a BackendError for a non-JSON 200 body', async () => {
    await expect(readJson(new Response('<html>oops</html>', { status: 200 }))).rejects.toBeInstanceOf(BackendError);
  });

  it('parses a valid success body', async () => {
    await expect(readJson(json({ ok: true }, 200))).resolves.toEqual({ ok: true });
  });
});

describe('error accessors', () => {
  it('reads type and status off a BackendError', () => {
    const error = new BackendError('nope', 'NotFound', 404);
    expect(getBackendErrorType(error)).toBe('NotFound');
    expect(getBackendErrorStatus(error)).toBe(404);
  });

  it('returns null for a non-BackendError', () => {
    expect(getBackendErrorType(new Error('plain'))).toBeNull();
    expect(getBackendErrorStatus(new Error('plain'))).toBeNull();
  });
});

describe('localized error messages', () => {
  const t = ((key: string, fallback?: string, opts?: Record<string, unknown>) =>
    opts ? `${fallback ?? key}` : (fallback ?? key)) as never;

  it('uses the mapped i18n key when the backend type is known', () => {
    const message = toLocalizedErrorMessage(t, new BackendError('gone', 'NotFound', 404), 'errors.generic', 'Generic');
    expect(message).toBeTruthy();
    expect(message).not.toBe('gone');
  });

  it('appends the server detail instead of discarding it', () => {
    // `Conflict` localizes to one word and `PayloadTooLarge` to two, so a
    // duplicate bucket name, the 10-credential cap, and the 50 MB upload cap all
    // surfaced with no information at all — even though the backend had sent a
    // specific `Exception.Message`. Localized first, server detail second.
    expect(toLocalizedErrorMessage(t, new BackendError('Volume already exists', 'Conflict', 400), 'errors.generic', 'Generic')).toBe(
      'Conflict. (Volume already exists)',
    );
  });

  it('does not double a message that merely restates the localized text', () => {
    expect(toLocalizedErrorMessage(t, new BackendError('Conflict', 'Conflict', 409), 'errors.generic', 'Generic')).toBe('Conflict.');
  });

  it('falls back for an unknown backend type', () => {
    const message = toLocalizedErrorMessage(t, new BackendError('weird', 'Teapot', 418), 'errors.generic', 'Generic');
    expect(message).toBeTruthy();
  });

  it('appends the detail for a non-BackendError too', () => {
    expect(toLocalizedErrorMessage(t, new Error('boom'), 'errors.generic', 'Generic')).toBe('Generic (boom)');
  });

  it('does not append an empty detail', () => {
    expect(toLocalizedErrorMessage(t, new Error(' '.repeat(3)), 'errors.generic', 'Generic')).toBe('Generic');
  });
});

describe('apiGet query building', () => {
  // Exercised through the public surface: `buildQuery` is internal, and the
  // interesting behaviour (skipping empty params, repeating array keys) is only
  // observable on the request URL.
  function capture(): { urls: string[]; restore: () => void } {
    const urls: string[] = [];
    const original = fetch;
    const stub: typeof fetch = (input) => {
      urls.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
      return Promise.resolve(Response.json({ ok: true }, { status: 200 }));
    };
    vi.stubGlobal('fetch', stub);
    return { urls, restore: () => void vi.stubGlobal('fetch', original) };
  }

  it('appends params and skips undefined/empty values', async () => {
    const { urls, restore } = capture();
    try {
      await apiGet('/api/x', { a: '1', b: undefined, c: '' });
      expect(urls[0]).toBe('/api/x?a=1');
    } finally {
      restore();
    }
  });

  it('repeats a key for array values', async () => {
    const { urls, restore } = capture();
    try {
      await apiGet('/api/x', { tag: ['a', 'b'] });
      expect(urls[0]).toBe('/api/x?tag=a&tag=b');
    } finally {
      restore();
    }
  });

  it('omits the query string entirely when there are no params', async () => {
    const { urls, restore } = capture();
    try {
      await apiGet('/api/x');
      await apiGet('/api/x', {});
      expect(urls[0]).toBe('/api/x');
      expect(urls[1]).toBe('/api/x');
    } finally {
      restore();
    }
  });
});

describe('formatting', () => {
  it('formats byte sizes at each unit boundary', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
  });

  it('describes an expiry in the near term', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(formatExpiryTimestamp(null)).toBe('Never');
    // Offsets are padded past each boundary: `Math.floor` of a delta measured a
    // few milliseconds after `nowSeconds` truncates down to the lower unit.
    expect(formatExpiryTimestamp(nowSeconds + 30)).toBe('Expires soon');
    expect(formatExpiryTimestamp(nowSeconds + 5 * 60 + 5)).toBe('Expires in 5m');
    expect(formatExpiryTimestamp(nowSeconds + 5 * 3600 + 5)).toBe('Expires in 5h');
    expect(formatExpiryTimestamp(nowSeconds + 5 * 86_400 + 5)).toBe('Expires in 5d');
    expect(formatExpiryTimestamp(nowSeconds + 90 * 86_400)).toContain('Expires ');
  });

  it('treats a past expiry as imminent rather than negative', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    // `diffMins < 1` catches negative deltas, so a stale credential reads as
    // "Expires soon" instead of "Expires in -60m".
    expect(formatExpiryTimestamp(past)).toBe('Expires soon');
  });
});
