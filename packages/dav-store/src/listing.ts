/**
 * Paged-collection constants and clamping.
 *
 * These live in `dav-store` (layer 2) rather than in the PROPFIND handler so the
 * browser plane, the DO, and any future JSON listing endpoint all clamp to the
 * same numbers. The DO is the enforcement point — the browser plane is a caller,
 * not a trust boundary — but sharing the constants keeps the two from drifting.
 */

/**
Entries per page when the caller does not ask for a size.
*/
const DEFAULT_PAGE_SIZE = 100;

/**
 * Ceiling on a caller-supplied page size.
 *
 * A page is fully hydrated: every entry on it costs a `statInner`, a
 * `dav_nodes` read, an `applicableLocks` query, and a `getDeadProperties` read
 * in `DavRepository.nodeInfo`. So `?limit=100000` would not make the DO slower
 * than one unpaged listing — it would reproduce the unpaged listing and then
 * serialise it, which is exactly the cost paging exists to avoid. 250 keeps the
 * largest page to a few hundred round trips.
 */
const MAX_PAGE_SIZE = 250;

/**
 * Clamp a requested page size into `[1, MAX_PAGE_SIZE]`.
 *
 * Deliberately total: `NaN`, `Infinity`, `0`, negatives, and fractions all
 * resolve to a usable value rather than propagating. `Math.trunc` first, so a
 * fractional `?limit=10.9` cannot be smuggled through as a float into the SQL
 * `LIMIT ?` binding.
 *
 * No lower clamp beyond 1. A small page is a legitimate request — a script
 * walking 10 entries at a time, a test asserting a page boundary — and rounding
 * *up* to a UI-shaped default would answer a different question than the one
 * asked. The opinionated page sizes belong to the browser's selector
 * (`PAGE_SIZE_OPTIONS`), not to the enforcement point.
 */
function clampPageSize(requested: unknown): number {
  const raw = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  const truncated = Math.trunc(raw);
  return truncated <= 0 ? DEFAULT_PAGE_SIZE : Math.min(truncated, MAX_PAGE_SIZE);
}

/**
 * Clamp a requested 1-based page number.
 *
 * `page < 1` is a first-page request (`?page=0` is a hand-edited or off-by-one
 * URL, not a request for "the page before the first"). The upper clamp happens
 * in the DO instead, because only the DO knows the collection size — see
 * `clampPageToCollection`.
 */
function clampPageNumber(requested: unknown): number {
  const raw = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(raw)) return 1;
  const truncated = Math.trunc(raw);
  return Math.max(truncated, 1);
}

/**
 * Clamp a page against a known collection size.
 *
 * A `?page=` that points past the end renders as an empty list, which reads as
 * "this folder is empty" — a wrong answer rather than an unhelpful one. Callers
 * pass the DO's authoritative count and the effective page size and get the last
 * real page instead. A `total` of 0 yields page 1 so the empty-collection case
 * is representable.
 */
function clampPageToCollection(page: number, total: number, pageSize: number): number {
  return total <= 0 ? 1 : Math.min(page, pageCountFor(total, pageSize));
}

/**
Total number of pages a collection of `total` entries spans at `pageSize`.
*/
function pageCountFor(total: number, pageSize: number): number {
  return total <= 0 ? 1 : Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/**
0-based row offset for a 1-based page number.
*/
function offsetForPage(page: number, pageSize: number): number {
  return Math.max(0, (page - 1) * Math.max(1, pageSize));
}

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageNumber, clampPageSize, clampPageToCollection, offsetForPage, pageCountFor };
