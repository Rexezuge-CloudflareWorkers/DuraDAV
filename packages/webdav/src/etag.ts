/**
 * What an ETag means, in the two directions this codebase needs.
 *
 * These used to be two functions both called `normalizeEtag`, in two packages,
 * doing two different things. Each is defensible on its own — one round-trips
 * what a server sent, the other implements a weak precondition comparison — and
 * a future caller reaching for "normalizeEtag" would have had a 50% chance of
 * picking the wrong one. So they live together here under names that state the
 * direction, and the difference is documented rather than discovered.
 */

/**
 * An ETag's body: quoting stripped, weakness **preserved**.
 *
 * Use this when reading a validator the *server* minted, to be re-emitted or
 * compared against another server's validator. A `W/"abc"` comes back as
 * `W/"abc"` with only the quotes removed.
 *
 * Dropping the prefix would be wrong here: `packages/backend-services`' planner
 * reads a strong match as proof the two sides hold the same bytes, so a weak
 * ETag that lost its marker would be over-trusted into a byte-identity claim it
 * never made.
 *
 * `null` in means no validator, and `null` out means there was none to keep
 * (empty, or nothing but quotes and whitespace) — never an empty string, which
 * would compare equal to a real empty-valued validator.
 */
function etagBody(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const weak = /^W\//i.test(trimmed);
  const body = weak ? trimmed.slice(2) : trimmed;
  const unquoted = body.startsWith('"') && body.endsWith('"') && body.length >= 2 ? body.slice(1, -1) : body;
  const value = unquoted.trim();
  if (value === '') return null;
  return weak ? `W/${value}` : value;
}

/**
 * A validator reduced to its weak comparison value: whitespace and `W/` stripped.
 *
 * Use this when comparing an `If-None-Match`/`If-Match` header against the
 * current validator. RFC 9110 §13.1.2 defines `If-None-Match` as a **weak**
 * comparison, so weakness is discarded on both sides before the compare — which
 * is why `W/"x"` must match the stored `"x"` here. Keeping the prefix (as
 * `etagBody` does) would fail that match and answer `200` where the
 * precondition was satisfied.
 *
 * Note this strips only `W/`, not the quotes: the values compared here are
 * already unquoted by the server, so quotes are not present in either operand.
 * Use `etagBody` when quoting has to come off too.
 */
function weakEtagValue(value: string): string {
  return value.trim().replace(/^W\//, '');
}

export { etagBody, weakEtagValue };