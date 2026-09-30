import { describe, expect, it } from 'vitest';
import { parseVolumePatch } from '../packages/backend-services/src/dav/VolumeCreatePolicy';
import { isD1ErrorRetryable } from '../packages/backend-data/src/utils/D1ErrorClassifier';
import { isMissingSchemaError } from '@durable-dav/shared/utils';
import { DavCredentialUtil } from '@durable-dav/shared/utils';
import { getDeadProperties } from '../packages/dav-store/src/meta';
import { generatePropfindResponse } from '@durable-dav/webdav';
import type { DavNodeInfo } from '@durable-dav/webdav';

/**
 * Regression tests for correctness bugs found in the hardening audit.
 *
 * Grouped by the invariant each one protects rather than by module, so a
 * failure names the rule that broke rather than the function it broke in.
 */

describe('volume visibility is validated by type, not by cast', () => {
  /**
   * The bug: `createVolume` passed only `hrefPrefixMode` to the validator, so
   * `isPrivate` reached the INSERT unvalidated. `"false"` then read as
   * `Number("false") === 1` → false → **public**, granting anonymous reads on a
   * bucket the caller had asked to make private.
   */
  it('rejects a stringly-typed isPrivate instead of storing it', () => {
    expect(() => parseVolumePatch({ isPrivate: 'false' })).toThrow(/boolean/);
    expect(() => parseVolumePatch({ isPrivate: 0 })).toThrow(/boolean/);
    // `null` is a wrong type too, and defaulting it to `true` would be a
    // second way to write the private-by-default rule by accident.
    expect(() => parseVolumePatch({ isPrivate: null })).toThrow(/boolean/);
    // Absent is the only way to mean "use the default", and the default is
    // private — never public.
    expect(parseVolumePatch({})).toEqual({ description: null, isPrivate: undefined, hrefPrefixMode: undefined });
    expect(parseVolumePatch({ isPrivate: false })).toEqual({ description: null, isPrivate: false, hrefPrefixMode: undefined });
    expect(parseVolumePatch({ isPrivate: true }).isPrivate).toBe(true);
  });

  it('rejects a non-string description and an over-long one', () => {
    expect(() => parseVolumePatch({ description: 42 })).toThrow(/string or null/);
    expect(() => parseVolumePatch({ description: { a: 1 } })).toThrow(/string or null/);
    expect(() => parseVolumePatch({ description: 'x'.repeat(501) })).toThrow(/500/);
    expect(parseVolumePatch({ description: 'x'.repeat(500) }).description).toHaveLength(500);
    // `null` clears the field and is explicitly allowed.
    expect(parseVolumePatch({ description: null }).description).toBeNull();
  });

  it('rejects an unknown href prefix mode', () => {
    expect(() => parseVolumePatch({ hrefPrefixMode: 'sideways' })).toThrow(/base, root/);
    expect(parseVolumePatch({ hrefPrefixMode: 'root' }).hrefPrefixMode).toBe('root');
  });
});

describe('D1 error classification prefers transient over permanent', () => {
  /**
   * The bug: the non-retryable list was consulted *first* and carried bare
   * `/range/i`, `/not\s+found/i`, `/permission/i`, `/authentication/i` and
   * `/authorization/i`. Any message matching both a transient signal and one of
   * those was classified permanent — so it was not retried by
   * `BaseDAO.withRetry` and surfaced as a 401/500 where a 503 was correct.
   *
   * Every case below matched the old non-retryable list *and* a retryable
   * signal, and so returned `false` before the reorder.
   */
  it('retries a transient failure that also contains a "not found"', () => {
    expect(isD1ErrorRetryable('connection: host not found')).toBe(true);
  });

  it('retries a transient failure that also mentions a range', () => {
    expect(isD1ErrorRetryable('connection reset: byte range not satisfiable')).toBe(true);
    expect(isD1ErrorRetryable('network error: value out of range')).toBe(true);
  });

  it('retries a transient failure that also mentions auth or authorization', () => {
    expect(isD1ErrorRetryable('retry: authentication backend unavailable')).toBe(true);
    expect(isD1ErrorRetryable('timeout waiting on network: authorization service')).toBe(true);
  });

  it('still refuses to retry a genuine conflict or constraint', () => {
    expect(isD1ErrorRetryable('UNIQUE constraint failed: users.email')).toBe(false);
    expect(isD1ErrorRetryable('FOREIGN KEY constraint failed')).toBe(false);
    expect(isD1ErrorRetryable('no such table: dav_volumes')).toBe(false);
    expect(isD1ErrorRetryable('row not found')).toBe(false);
  });

  it('does not retry a permanent name-resolution failure with no transient signal', () => {
    // `ENOTFOUND` carries neither `connection` nor `network`, and a persistent
    // NXDOMAIN will not fix itself. The old `/range/i` and `/not\s+found/i`
    // patterns did not cause this one to be wrong, and narrowing them must not
    // start retrying it.
    expect(isD1ErrorRetryable('getaddrinfo ENOTFOUND db.example')).toBe(false);
  });

  it('retries the transient conditions it is meant to', () => {
    expect(isD1ErrorRetryable('database is locked')).toBe(true);
    expect(isD1ErrorRetryable('request timed out')).toBe(true);
    expect(isD1ErrorRetryable('Too many requests')).toBe(true);
    expect(isD1ErrorRetryable('deadlock detected')).toBe(true);
    expect(isD1ErrorRetryable('resource busy')).toBe(true);
    expect(isD1ErrorRetryable('')).toBe(false);
  });
});

describe('isMissingSchemaError is the only failure a dead-prop read may swallow', () => {
  /**
   * The bug: `getDeadProperties` caught *every* SQL error and returned `[]`, so
   * a corrupt or busy DO reported "this resource has no dead properties" — and
   * a `PROPPATCH` that had already written the row 404'd the property in the
   * very next PROPFIND, with nothing logged.
   */
  const sqlThatThrows = (message: string) => ({
    exec: () => {
      throw new Error(message);
    },
  });

  it('degrades to empty only for a missing table', () => {
    expect(getDeadProperties(sqlThatThrows('no such table: dav_props'), '/a')).toEqual([]);
    expect(getDeadProperties(sqlThatThrows('no such column: value_xml'), '/a')).toEqual([]);
  });

  it('propagates a corrupt or busy database', () => {
    expect(() => getDeadProperties(sqlThatThrows('database disk image is malformed'), '/a')).toThrow(/malformed/);
    expect(() => getDeadProperties(sqlThatThrows('database is locked'), '/a')).toThrow(/locked/);
  });

  it('recognises a thrown string as well as an Error', () => {
    expect(isMissingSchemaError('no such table: x')).toBe(true);
    expect(isMissingSchemaError(new Error('no such table: x'))).toBe(true);
    expect(isMissingSchemaError(new Error('syntax error'))).toBe(false);
    expect(isMissingSchemaError(undefined)).toBe(false);
    expect(isMissingSchemaError(42)).toBe(false);
  });
});

describe('PROPFIND lockdiscovery hrefs carry the volume base', () => {
  /**
   * The bug: the named-`<prop>` path called `toLiveProperties(node)` with no
   * `base`, so `lockdiscovery`'s `lockroot` href came back as `/dir/file.txt`
   * while the `allprop` path for the *same resource* returned
   * `/alice/photos/dir/file.txt`. RFC 4918 §8.3 requires every href to resolve
   * against the request URL, so one of the two sent the client outside the
   * volume.
   */
  const lockedNode: DavNodeInfo = {
    key: 'dir/file.txt',
    isCollection: false,
    size: 4,
    etag: '"abc"',
    mtime: new Date('2026-01-02T03:04:05Z'),
    crtime: new Date('2026-01-01T00:00:00Z'),
    contentType: 'text/plain',
    displayname: 'file.txt',
    locks: [{ token: 'opaquelocktoken:1', scope: 'exclusive', depth: '0', timeout: 'Second-3600', owner: 'alice', root: '', expiresAt: 0 }],
    deadProperties: [],
  };

  it('agrees between allprop and a named lockdiscovery request', () => {
    const base = '/alice/photos';
    const allprop = generatePropfindResponse(lockedNode, 'allprop', [], base);
    const named = generatePropfindResponse(lockedNode, 'prop', [{ namespaceURI: 'DAV:', localName: 'lockdiscovery', prefix: 'D', valueXml: '' }], base);

    // `lockdiscovery` carries two hrefs: the lock *token* (a `urn:uuid:`, which
    // is not a path and must not be touched) and the `lockroot` (the path, which
    // is what the base applies to). Matching the first href would have compared
    // two identical urns and passed while the bug was live.
    const lockRootOf = (xml: string): string | undefined => /<lockroot><href>([^<]*)<\/href><\/lockroot>/.exec(xml)?.[1];
    expect(lockRootOf(allprop)).toBe('/alice/photos/dir/file.txt');
    expect(lockRootOf(named)).toBe(lockRootOf(allprop));
    // The token href must be left alone in both shapes.
    expect(allprop).toContain('<locktoken><href>urn:uuid:opaquelocktoken:1</href></locktoken>');
    expect(named).toContain('<locktoken><href>urn:uuid:opaquelocktoken:1</href></locktoken>');
  });

  it('returns an empty lockdiscovery when nothing is locked', () => {
    const unlocked: DavNodeInfo = { ...lockedNode, locks: [] };
    const named = generatePropfindResponse(unlocked, 'prop', [{ namespaceURI: 'DAV:', localName: 'lockdiscovery', prefix: 'D', valueXml: '' }], '/alice/photos');
    expect(named).toContain('<lockdiscovery></lockdiscovery>');
  });
});

describe('PBKDF2 iteration counts are bounded on both ends', () => {
  /**
   * The bug: `Number.isSafeInteger` accepted `Number.MAX_SAFE_INTEGER`, so a
   * corrupt or hostile `dav_credentials` row could name a work factor that
   * turned one unauthenticated Basic request into a derivation measured in
   * years.
   */
  it('refuses a work factor above the ceiling instead of deriving with it', async () => {
    const hostile = 'pbkdf2-sha256$9007199254740991$c2FsdA$aGFzaA';
    await expect(DavCredentialUtil.verifyPassword('guess', hostile)).resolves.toEqual({ ok: false, needsRehash: false });
  });

  it('still verifies a legitimate hash', async () => {
    const hash = await DavCredentialUtil.hashPassword('correct horse');
    await expect(DavCredentialUtil.verifyPassword('correct horse', hash)).resolves.toEqual({ ok: true, needsRehash: false });
    await expect(DavCredentialUtil.verifyPassword('wrong horse', hash)).resolves.toEqual({ ok: false, needsRehash: false });
  });

  it('refuses a non-positive or non-integer work factor', async () => {
    for (const iterations of ['0', '-1', '1e300', 'abc']) {
      await expect(DavCredentialUtil.verifyPassword('x', `pbkdf2-sha256$${iterations}$c2FsdA$aGFzaA`)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    }
  });

  it('refuses an over-ceiling work factor without attempting the derivation', async () => {
    // The security property is that the *rejection is cheap*: an over-ceiling
    // count must be refused before `pbkdf2` is called at all, or the clamp
    // would only have moved the cost. A deliberately huge count is therefore
    // safe to assert on — it returns in well under a millisecond precisely
    // because no work is done. (A count just *under* the ceiling is the
    // opposite case: it is accepted, and proving that means paying for the
    // derivation, so it is not asserted here.)
    const started = Date.now();
    await expect(DavCredentialUtil.verifyPassword('x', `pbkdf2-sha256$10000001$${btoa('salt')}$${btoa('hash')}`)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
