/**
 * Egress policy for user-supplied remote URLs.
 *
 * Scheduled replication turns a bucket owner into someone who can name a host
 * this Worker will connect to. Without a policy that is server-side request
 * forgery against Cloudflare's own egress: the metadata service, the loopback
 * interface, and anything reachable on a private network the Worker happens to
 * share.
 *
 * HTTPS-only and public-address-only by default. `REPLICATION_ALLOWED_HOSTS` is
 * the operator escape hatch, because the most common replication target in
 * practice is a Nextcloud box on a LAN and a policy with no way to permit it
 * would make the feature useless exactly where it is wanted. It is a widening,
 * it is logged, and it is empty by default.
 *
 * Known gap, stated rather than hidden: DNS rebinding is not covered. A host
 * that resolves to a public address at validation time and a private one when
 * the connection is made defeats every check here. Closing it needs a
 * resolution-aware fetch, which the platform does not expose to a Worker.
 */

const MAX_REMOTE_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;

/**
Host suffixes that never name a real internet peer.
*/
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
Hostnames that resolve inward by definition.
*/
const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

type UrlPolicyOptions = {
  /**
   * Hostnames (exact, or `.suffix` form) permitted regardless of the address
   * rules. Only ever populated from operator configuration, never from the
   * request body.
   */
  allowedHosts?: readonly string[];
};

class RemoteUrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUrlRejectedError';
  }
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Is this IPv4 literal in a range a Worker must never reach?
 *
 * `0.0.0.0/8` and `169.254.0.0/16` matter as much as RFC 1918: the first is
 * "this host" on Linux, the second is the cloud metadata endpoint.
 */
function isBlockedIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if ([0, 10, 127].includes(a)) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Decode an IPv4-mapped IPv6 address back into its four octets, or null.
 *
 * Both spellings have to be handled. `new URL` canonicalizes
 * `https://[::ffff:10.0.0.1]/` to the hex form `[::ffff:a00:1]`, so a check
 * written only against the dotted text never fires — and that address connects to
 * a private network.
 */
function mappedIpv4Octets(literal: string): number[] | null {
  const dotted = /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/.exec(literal);
  const dottedText = literal.slice('::ffff:'.length);
  if (dotted !== null) return ipv4Octets(dottedText);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(literal);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return !Number.isFinite(high) || !Number.isFinite(low) ? null : [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/**
 * Is this IPv6 literal private, loopback, or an IPv4 address in disguise?
 *
 * The last case is the one that matters: `::ffff:127.0.0.1` is a perfectly valid
 * URL and connects to loopback, so the embedded IPv4 must be re-checked rather
 * than the literal waved through because it "is" IPv6.
 */
function isBlockedIpv6(literal: string): boolean {
  const lower = literal.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // Zone ids (`fe80::1%eth0`) name a local interface directly.
  if (lower.includes('%')) return true;
  const mapped = mappedIpv4Octets(lower);
  if (mapped !== null) return isBlockedIpv4(mapped);
  const head = lower.split(':', 1)[0] ?? '';
  if (head === '') return false;
  const group = Number.parseInt(head.padStart(4, '0').slice(0, 4), 16);
  if (!Number.isFinite(group)) return false;
  // fc00::/7 unique-local, fe80::/10 link-local.
  return (group & 0xfe_00) === 0xfc_00 || (group & 0xff_c0) === 0xfe_80;
}

/**
 * Does this host name a numeric address in a non-dotted spelling?
 *
 * `http://2130706433/` and `http://0x7f.1/` are loopback written in a form
 * `URL` keeps verbatim in `hostname`, so the dotted-literal check above never
 * sees them. Resolving requires a DNS answer we deliberately do not make, so
 * the safe answer is to refuse every host that is not a plain dotted quad or a
 * bracketed IPv6 literal.
 */
function looksLikeObfuscatedNumericHost(host: string): boolean {
  if (isIpv4Literal(host) || host.startsWith('[') || !/^[0-9a-fx.]+$/i.test(host)) return false;
  // A bare hex or octal number, or dotted groups with a non-decimal group.
  return /^(?:0x[0-9a-f]+|0[0-7]+)$/i.test(host) || host.split('.').some((group) => /^0x[0-9a-f]+$/i.test(group));
}

function hostIsAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate === '') return false;
    return candidate.startsWith('.') ? lower.endsWith(candidate) : lower === candidate;
  });
}

/**
 * Validate and canonicalise a remote URL.
 *
 * Throws `RemoteUrlRejectedError` with a message meant for the owner: every
 * rejection here is a configuration mistake or an attack, and saying which one
 * is what makes the difference between a fixable setup error and a support
 * ticket. Query and fragment are dropped — a WebDAV base URL has no use for
 * either, and keeping them would let `?a=b` smuggle a second meaning past the
 * path checks the sync engine does.
 */
function normalizeRemoteUrl(raw: unknown, options: UrlPolicyOptions = {}): string {
  if (typeof raw !== 'string') throw new RemoteUrlRejectedError('remoteUrl must be a string');
  const trimmed = raw.trim();
  if (trimmed === '') throw new RemoteUrlRejectedError('remoteUrl is required');
  if (trimmed.length > MAX_REMOTE_URL_LENGTH) throw new RemoteUrlRejectedError(`remoteUrl must be at most ${MAX_REMOTE_URL_LENGTH} characters`);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RemoteUrlRejectedError('remoteUrl is not a valid absolute URL');
  }

  if (url.protocol !== 'https:') throw new RemoteUrlRejectedError('remoteUrl must use https');
  if (url.username !== '' || url.password !== '') throw new RemoteUrlRejectedError('remoteUrl must not embed credentials; use the auth fields instead');
  if (url.port !== '' && url.port !== '443') throw new RemoteUrlRejectedError('remoteUrl must use the default https port');

  const host = url.hostname.toLowerCase();
  if (host === '') throw new RemoteUrlRejectedError('remoteUrl must include a host');
  if (hostIsAllowed(host, options.allowedHosts ?? [])) {
    url.search = '';
    url.hash = '';
    return url.href;
  }

  if (BLOCKED_HOSTNAMES.has(host)) throw new RemoteUrlRejectedError(`remoteUrl host ${host} is not routable`);
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) throw new RemoteUrlRejectedError(`remoteUrl host ${host} is not a public hostname`);
  }
  if (looksLikeObfuscatedNumericHost(host)) throw new RemoteUrlRejectedError(`remoteUrl host ${host} is a numeric address in a non-canonical form`);

  if (isIpv4Literal(host)) {
    const octets = ipv4Octets(host);
    if (octets === null || isBlockedIpv4(octets)) throw new RemoteUrlRejectedError(`remoteUrl host ${host} is not a public address`);
  } else if (host.startsWith('[')) {
    if (isBlockedIpv6(host.slice(1, -1))) throw new RemoteUrlRejectedError(`remoteUrl host ${host} is not a public address`);
  } else if (!host.includes('.')) {
    // A single-label name can only be resolved through a local search domain.
    throw new RemoteUrlRejectedError(`remoteUrl host ${host} is not a fully qualified hostname`);
  }

  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Re-validate the target of a redirect.
 *
 * Called for every hop rather than once at the start. Validating the configured
 * URL and then following `Location` unchecked is a classic TOCTOU: the first
 * hop is public, the second is `169.254.169.254`, and the policy has already
 * returned by then.
 */
function resolveRedirectUrl(baseUrl: string, location: string, options: UrlPolicyOptions = {}): string {
  let next: URL;
  try {
    next = new URL(location, baseUrl);
  } catch {
    throw new RemoteUrlRejectedError('redirect target is not a valid URL');
  }
  if (next.protocol !== 'https:') throw new RemoteUrlRejectedError('redirect target must use https');
  // Same host: no need to re-run the whole policy, and a redirect back to the
  // origin's own host is the overwhelmingly common case.
  if (next.host.toLowerCase() === new URL(baseUrl).host.toLowerCase()) {
    next.search = '';
    next.hash = '';
    return next.href;
  }
  return normalizeRemoteUrl(next.href, options);
}

function parseAllowedHosts(raw: unknown): string[] {
  return typeof raw !== 'string' || raw.trim() === '' ? [] : raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export {
  normalizeRemoteUrl,
  resolveRedirectUrl,
  parseAllowedHosts,
  RemoteUrlRejectedError,
  MAX_REMOTE_URL_LENGTH,
  MAX_REDIRECTS,
  BLOCKED_HOST_SUFFIXES,
  BLOCKED_HOSTNAMES,
};
export type { UrlPolicyOptions };
