import { describe, expect, it } from 'vitest';
import { applyDavForwardHeaders } from '../apps/api/src/workers/routes/davForwardHeaders';

/**
 * Regression tests for the header set both front-door planes hand to the DO.
 *
 * Each "before" note describes a real bug: the DAV plane and the browser plane
 * each implemented this separately and the two drifted, so a rule that existed
 * on one plane was missing on the other. The browser plane deleted a
 * caller-supplied `X-Dav-Page*`; the DAV plane did not — so a native client
 * could hand-set them, get a truncated `Depth: 1` multistatus, and have that
 * truncated body written to a cache key that carries no page term.
 */

const BASE = { base: '/alice/photos', inner: 'dir', hrefPrefixMode: 'base' as const };

describe('applyDavForwardHeaders', () => {
  it('never lets a caller-supplied X-Dav-Page reach the DO', () => {
    // The regression: on the WebDAV plane these survived, which violated
    // RFC 4918 §9.1 (no paging concept) *and* poisoned the read cache.
    const h = applyDavForwardHeaders(
      new Headers({ 'X-Dav-Page': '2', 'X-Dav-Page-Limit': '1' }),
      { ...BASE, userEmail: 'owner@example.com' },
    );
    expect(h.get('X-Dav-Page')).toBeNull();
    expect(h.get('X-Dav-Page-Limit')).toBeNull();
  });

  it('sets paging only when the caller opted in, and only for the values given', () => {
    const both = applyDavForwardHeaders(new Headers(), { ...BASE, userEmail: null, page: { page: '3', limit: '25' } });
    expect(both.get('X-Dav-Page')).toBe('3');
    expect(both.get('X-Dav-Page-Limit')).toBe('25');

    // A partial opt-in must not resurrect the other value.
    const pageOnly = applyDavForwardHeaders(new Headers(), { ...BASE, userEmail: null, page: { page: '3', limit: null } });
    expect(pageOnly.get('X-Dav-Page')).toBe('3');
    expect(pageOnly.get('X-Dav-Page-Limit')).toBeNull();

    const limitOnly = applyDavForwardHeaders(new Headers(), { ...BASE, userEmail: null, page: { page: null, limit: '25' } });
    expect(limitOnly.get('X-Dav-Page')).toBeNull();
    expect(limitOnly.get('X-Dav-Page-Limit')).toBe('25');
  });

  it('overwrites X-Dav-Href-Prefix-Mode even when the caller set one', () => {
    // The regression: a client-sent `root` would otherwise reach the DO and
    // silently change the addressing shape of a bucket whose owner chose
    // `base`.
    const h = applyDavForwardHeaders(new Headers({ 'X-Dav-Href-Prefix-Mode': 'root' }), { ...BASE, userEmail: null });
    expect(h.get('X-Dav-Href-Prefix-Mode')).toBe('base');
  });

  it('overwrites X-Dav-User even when the caller set one', () => {
    const h = applyDavForwardHeaders(new Headers({ 'X-Dav-User': 'admin@evil.example' }), { ...BASE, userEmail: 'real@example.com' });
    expect(h.get('X-Dav-User')).toBe('real@example.com');
  });

  it('reports a null owner as an empty string rather than the literal "null"', () => {
    const h = applyDavForwardHeaders(new Headers(), { ...BASE, userEmail: null });
    expect(h.get('X-Dav-User')).toBe('');
  });

  it('strips Authorization so credentials never reach the DO', () => {
    const h = applyDavForwardHeaders(new Headers({ Authorization: 'Basic dXNlcjpwYXNz' }), { ...BASE, userEmail: null });
    expect(h.get('Authorization')).toBeNull();
  });

  it('sets the addressing headers from the resolved base and inner path', () => {
    const h = applyDavForwardHeaders(new Headers(), { ...BASE, userEmail: null });
    expect(h.get('X-Dav-Base')).toBe('/alice/photos');
    expect(h.get('X-Dav-Path')).toBe('dir');
  });

  it('overwrites client-supplied addressing headers', () => {
    // `X-Dav-Base`/`X-Dav-Path` are the DO's whole addressing model, so a
    // client value that survived would let a request name a resource in a
    // different volume.
    const h = applyDavForwardHeaders(
      new Headers({ 'X-Dav-Base': '/bob/secret', 'X-Dav-Path': '../escape' }),
      { ...BASE, userEmail: null },
    );
    expect(h.get('X-Dav-Base')).toBe('/alice/photos');
    expect(h.get('X-Dav-Path')).toBe('dir');
  });

  it('drops a Destination when none was resolved', () => {
    // The DO only acts on `Destination` for COPY/MOVE, so forwarding a stray
    // one on a PUT hands a client-controlled header to code that might later
    // start reading it.
    const h = applyDavForwardHeaders(new Headers({ Destination: 'https://attacker.example/x' }), { ...BASE, userEmail: null });
    expect(h.get('Destination')).toBeNull();
  });

  it('uses the resolved Destination when one is supplied', () => {
    const h = applyDavForwardHeaders(
      new Headers({ Destination: '/raw/client/value' }),
      { ...BASE, userEmail: null, destination: 'https://host/alice/photos/target' },
    );
    expect(h.get('Destination')).toBe('https://host/alice/photos/target');
  });

  it('preserves unrelated request headers', () => {
    const h = applyDavForwardHeaders(
      new Headers({ Depth: '1', 'Content-Type': 'application/xml', 'If-Match': '"etag"' }),
      { ...BASE, userEmail: null },
    );
    expect(h.get('Depth')).toBe('1');
    expect(h.get('Content-Type')).toBe('application/xml');
    expect(h.get('If-Match')).toBe('"etag"');
  });

  it('does not mutate the source Headers', () => {
    const source = new Headers({ 'X-Dav-Page': '2', Authorization: 'Basic x' });
    applyDavForwardHeaders(source, { ...BASE, userEmail: null, page: { page: '9', limit: '9' } });
    expect(source.get('X-Dav-Page')).toBe('2');
    expect(source.get('Authorization')).toBe('Basic x');
  });
});
