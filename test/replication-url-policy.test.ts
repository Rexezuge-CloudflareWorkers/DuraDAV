/* eslint-disable unicorn/prefer-https -- every `http://` in this file is the subject
   under test, not an endpoint. The policy's first rule is that a remote URL must use
   HTTPS, and each of these strings exists to prove a plain-HTTP URL is *rejected*;
   `unicorn/prefer-https`'s autofix rewrites them to `https://`, which silently turns
   three assertions into "accepts a valid URL" and leaves the suite green. */
import { describe, expect, it } from 'vitest';
import { normalizeRemoteUrl, resolveRedirectUrl, parseAllowedHosts, RemoteUrlRejectedError } from '@durable-dav/shared/net';

/**
 * The egress policy.
 *
 * Scheduled replication turns a bucket owner into someone who can name a host
 * this Worker connects to, so these checks are the boundary between "configure a
 * backup target" and server-side request forgery against Cloudflare's own egress.
 * Every rejection below is a real address class an attacker reaches for.
 */

function rejects(raw: string, allowedHosts: string[] = []): void {
  expect(() => normalizeRemoteUrl(raw, { allowedHosts })).toThrow(RemoteUrlRejectedError);
}

describe('normalizeRemoteUrl — accepted', () => {
  it('accepts a public https URL and canonicalises it', () => {
    expect(normalizeRemoteUrl('https://dav.example.com/files/me')).toBe('https://dav.example.com/files/me');
  });

  it('strips the query and fragment', () => {
    // A WebDAV base URL has no use for either, and keeping them would let
    // `?a=b` smuggle a second meaning past the path checks the engine does.
    expect(normalizeRemoteUrl('https://dav.example.com/files?x=1#frag')).toBe('https://dav.example.com/files');
  });

  it('preserves an explicit port 443', () => {
    expect(normalizeRemoteUrl('https://dav.example.com:443/files')).toBe('https://dav.example.com/files');
  });

  it('accepts a host on the operator allowlist regardless of its address', () => {
    // The escape hatch exists because the most common real target is a
    // self-hosted server on a private network.
    expect(normalizeRemoteUrl('https://nextcloud.lan/files', { allowedHosts: ['nextcloud.lan'] })).toBe('https://nextcloud.lan/files');
    expect(normalizeRemoteUrl('https://box.internal/files', { allowedHosts: ['.internal'] })).toBe('https://box.internal/files');
  });
});

describe('normalizeRemoteUrl — rejected', () => {
  it('rejects non-https schemes', () => {
    rejects('http://dav.example.com/files');
    rejects('ftp://dav.example.com/files');
    rejects('file:///etc/passwd');
    rejects('gopher://dav.example.com/');
  });

  it('rejects embedded credentials', () => {
    // The URL is stored and re-normalised on every sync; credentials in it would
    // be persisted outside the encrypted envelope.
    rejects('https://user:pass@dav.example.com/files');
  });

  it('rejects a non-default port', () => {
    rejects('https://dav.example.com:8443/files');
  });

  it('rejects loopback in every spelling', () => {
    rejects('https://127.0.0.1/files');
    rejects('https://127.1.2.3/files');
    rejects('https://localhost/files');
    rejects('https://localhost.localdomain/files');
    rejects('https://[::1]/files');
    rejects('https://[::]/files');
    // Numeric forms that `URL` keeps verbatim, so a dotted-literal check never
    // sees them.
    rejects('https://2130706433/files');
    rejects('https://0x7f000001/files');
    rejects('https://0x7f.1/files');
  });

  it('rejects the cloud metadata endpoint', () => {
    // 169.254.0.0/16 matters as much as RFC 1918: it is where instance
    // credentials live.
    rejects('https://169.254.169.254/latest/meta-data/');
  });

  it('rejects private network ranges', () => {
    rejects('https://10.0.0.5/files');
    rejects('https://172.16.0.1/files');
    rejects('https://172.31.255.254/files');
    rejects('https://192.168.1.1/files');
  });

  it('rejects CGNAT and 0.x', () => {
    rejects('https://100.64.0.1/files');
    rejects('https://100.127.255.254/files');
    rejects('https://0.0.0.0/files');
  });

  it('allows 172.32.x — outside RFC 1918, and genuinely routable', () => {
    // The off-by-one guard against over-blocking, which would make the policy
    // look stricter than it is while costing real users a working target.
    expect(() => normalizeRemoteUrl('https://172.32.0.1/files')).not.toThrow();
  });

  it('rejects IPv6 unique-local and link-local', () => {
    rejects('https://[fd00::1]/files');
    rejects('https://[fe80::1]/files');
    rejects('https://[fe80::1%25eth0]/files');
  });

  it('rejects an IPv4-mapped IPv6 loopback', () => {
    // `::ffff:127.0.0.1` is a perfectly valid URL and connects to loopback, so the
    // embedded IPv4 has to be re-checked rather than the literal waved through
    // because it "is" IPv6.
    rejects('https://[::ffff:127.0.0.1]/files');
    rejects('https://[::ffff:10.0.0.1]/files');
  });

  it('rejects local-only hostname suffixes', () => {
    rejects('https://nas.local/files');
    rejects('https://db.internal/files');
    rejects('https://router.home.arpa/files');
  });

  it('rejects a single-label hostname', () => {
    // A single label can only resolve through a local search domain.
    rejects('https://intranet/files');
  });

  it('rejects a non-string or empty value', () => {
    rejects('');
    rejects(' '.repeat(3));
    rejects(undefined as unknown as string);
    rejects(42 as unknown as string);
  });

  it('rejects an over-long URL', () => {
    rejects(`https://dav.example.com/${'a'.repeat(2100)}`);
  });

  it('names the offending host in the message', () => {
    // The owner configures a target and needs to know which part to fix.
    expect(() => normalizeRemoteUrl('https://127.0.0.1/files')).toThrow(/127\.0\.0\.1/);
    expect(() => normalizeRemoteUrl('http://dav.example.com/')).toThrow(/https/);
  });
});

describe('resolveRedirectUrl', () => {
  it('follows a same-host redirect without re-running the whole policy', () => {
    expect(resolveRedirectUrl('https://dav.example.com/a', '/b')).toBe('https://dav.example.com/b');
  });

  it('re-validates every hop rather than trusting the first one', () => {
    // Validating the configured URL and then following `Location` unchecked is a
    // classic TOCTOU: hop one is public, hop two is the metadata service.
    expect(() => resolveRedirectUrl('https://dav.example.com/a', 'https://169.254.169.254/')).toThrow(RemoteUrlRejectedError);
    expect(() => resolveRedirectUrl('https://dav.example.com/a', 'https://127.0.0.1/')).toThrow(RemoteUrlRejectedError);
    expect(() => resolveRedirectUrl('https://dav.example.com/a', 'http://dav.example.com/b')).toThrow(RemoteUrlRejectedError);
  });

  it('permits a cross-host redirect to an allowlisted host', () => {
    expect(resolveRedirectUrl('https://dav.example.com/a', 'https://nextcloud.lan/b', { allowedHosts: ['nextcloud.lan'] })).toBe(
      'https://nextcloud.lan/b',
    );
  });

  it('rejects an unparseable location', () => {
    expect(() => resolveRedirectUrl('https://dav.example.com/a', 'http://')).toThrow(RemoteUrlRejectedError);
  });
});

describe('parseAllowedHosts', () => {
  it('returns an empty list for an unset or blank value', () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('')).toEqual([]);
    expect(parseAllowedHosts(' '.repeat(3))).toEqual([]);
  });

  it('splits and trims a comma-separated list', () => {
    expect(parseAllowedHosts('a.example.com, .internal ,b.example.com')).toEqual(['a.example.com', '.internal', 'b.example.com']);
  });

  it('drops empty entries so a trailing comma does not allowlist everything', () => {
    // An empty allowlist entry that matched every host would defeat the policy
    // entirely, and `'a,,b'` is an easy typo to make.
    expect(parseAllowedHosts('a.example.com,,')).toEqual(['a.example.com']);
  });
});
