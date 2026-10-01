import { describe, expect, it } from 'vitest';
import { getParentPath, isSameOrDescendantPath, renderMultiStatusFailures } from '@durable-dav/webdav';

/**
 * RFC 4918 conformance and data-integrity regressions found by audit.
 *
 * These are the pure, deterministic pieces: the 207 failure renderer, and the
 * path algebra that COPY/MOVE ordering decisions depend on. The behavioural
 * halves of the same fixes (validate `Depth` *before* deleting the destination;
 * do not re-path `dav_locks`; do not delete a lock-null resource that was
 * uploaded) are asserted in `test/integration/api/DavRfc4918Semantics.int.test.ts`
 * against a real Durable Object, because a double cannot prove that bytes on a
 * filesystem survive a rejected request.
 */

/**
 * A `207 Multi-Status` body naming the resources a multi-resource operation
 * failed on.
 *
 * §9.8.3: "If an error occurs with a resource other than the resource identified
 * in the Request-URI, then the response MUST be a 207 (Multi-Status), and the URL
 * of the resource causing the failure MUST appear with the specific error."
 */
describe('multi-status failure renderer', () => {
  it('names every failed resource with its status', () => {
    const xml = renderMultiStatusFailures([
      { href: '/alice/vol/a/big1.bin', status: 'HTTP/1.1 507 Insufficient Storage' },
      { href: '/alice/vol/a/big2.bin', status: 'HTTP/1.1 507 Insufficient Storage' },
    ]);
    expect(xml).toContain('<D:multistatus');
    expect(xml).toContain('xmlns:D="DAV:"');
    expect(xml).toContain('<href>/alice/vol/a/big1.bin</href>');
    expect(xml).toContain('<href>/alice/vol/a/big2.bin</href>');
    expect(xml.match(/<status>/g)).toHaveLength(2);
    expect(xml).toContain('HTTP/1.1 507 Insufficient Storage');
  });

  it('omits the propstat wrapper, because the failure is of the resource', () => {
    // A `<propstat>` would claim something about the resource's *properties*;
    // what failed is the resource itself.
    expect(renderMultiStatusFailures([{ href: '/a', status: 'HTTP/1.1 507' }])).not.toContain('propstat');
  });

  it('includes an optional reason when one is given', () => {
    const withReason = renderMultiStatusFailures([{ href: '/a', status: 'HTTP/1.1 507', description: 'ENOSPC' }]);
    expect(withReason).toContain('ENOSPC');
    expect(renderMultiStatusFailures([{ href: '/a', status: 'HTTP/1.1 507' }])).not.toContain('ENOSPC');
  });

  it('escapes an href and a reason carrying XML metacharacters', () => {
    // `href` is derived from client-controlled path segments, so an unescaped
    // `<` or `&` would let a file name break out of its element.
    const xml = renderMultiStatusFailures([{ href: '/a<b&c', status: 'HTTP/1.1 507', description: 'a<b&c' }]);
    expect(xml).toContain('&lt;b&amp;c');
    expect(xml).not.toContain('/a<b&c');
  });

  it('renders an empty multistatus for no failures', () => {
    // Not used by the handler (it short-circuits on zero failures), but the
    // shape must stay well-formed for any caller that does pass an empty list.
    const xml = renderMultiStatusFailures([]);
    expect(xml).toContain('multistatus');
    expect(xml).not.toContain('<response>');
  });
});

/**
 * The path algebra that `resolveDestination` relies on to decide self/descendant
 * rejection *before* anything is deleted.
 */
describe('COPY/MOVE destination path algebra', () => {
  it('treats equality as a descendant, so a self-copy is refused', () => {
    expect(isSameOrDescendantPath('a/b', 'a/b')).toBe(true);
  });

  it('treats a nested path as a descendant', () => {
    expect(isSameOrDescendantPath('a', 'a/b/c')).toBe(true);
    expect(isSameOrDescendantPath('', 'a')).toBe(true);
  });

  it('does not treat a sibling or a name-prefixed sibling as a descendant', () => {
    // `ab` is not under `a`: a prefix test on the raw string would call this a
    // self-copy and refuse a legitimate rename.
    expect(isSameOrDescendantPath('a', 'ab')).toBe(false);
    expect(isSameOrDescendantPath('a/b', 'a/bc')).toBe(false);
    expect(isSameOrDescendantPath('a/b', 'a/c')).toBe(false);
  });

  it('walks to the volume root', () => {
    expect(getParentPath('a')).toBe('');
    expect(getParentPath('a/b/c')).toBe('a/b');
    expect(getParentPath('a/b')).toBe('a');
    // The root is its own parent, which is what bounds the ancestor walks.
    expect(getParentPath('')).toBe('');
  });
});