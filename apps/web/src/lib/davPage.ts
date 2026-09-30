/**
 * Client-side paging for the bucket browser.
 *
 * The page number lives in the URL (`?page=`), next to the existing `?path=`,
 * so a folder+page link is shareable and survives refresh and back/forward. The
 * page *size* is a preference rather than navigation state, so it lives in
 * `localStorage` instead — putting it in the URL would make every size change
 * push a history entry.
 *
 * Values arriving from the URL are untrusted: `?page=` is hand-editable, so it
 * is clamped here and again in the DO. The two clamps are not redundant — this
 * one keeps a nonsense URL from issuing a request at all, the DO's is what
 * actually bounds the work.
 */

/**
Page sizes offered by the selector. The only "sane" values a caller picks.
*/
const PAGE_SIZE_OPTIONS: readonly number[] = [50, 100, 250];

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const PAGE_SIZE_STORAGE_KEY = 'durable-dav-page-size';

/**
Read the persisted page size, falling back to the default.
*/
function readStoredPageSize(): number {
  try {
    const raw = globalThis.localStorage?.getItem(PAGE_SIZE_STORAGE_KEY);
    return raw == null ? DEFAULT_PAGE_SIZE : clampPageSize(Number(raw));
  } catch {
    // Private-mode Safari and a blocked-storage context both throw here. A
    // default is the right answer either way — paging still works, it just
    // does not persist.
    return DEFAULT_PAGE_SIZE;
  }
}

/**
Persist the page size. Failures are silent for the same reason as above.
*/
function storePageSize(limit: number): void {
  try {
    globalThis.localStorage?.setItem(PAGE_SIZE_STORAGE_KEY, String(clampPageSize(limit)));
  } catch {
    // Non-fatal: the selection still applies to this session.
  }
}

/**
 * Clamp a page size to `[1, MAX_PAGE_SIZE]`.
 *
 * No minimum. A small page is a legitimate request — a script listing 10
 * entries at a time, a test asserting a page boundary — and clamping *up* to a
 * UI-shaped default would silently answer a different question than the one
 * asked. `PAGE_SIZE_OPTIONS` is where the opinionated choices live.
 */
function clampPageSize(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  const truncated = Math.trunc(raw);
  return truncated <= 0 ? DEFAULT_PAGE_SIZE : Math.min(truncated, MAX_PAGE_SIZE);
}

/**
 * Read a `?page=` value as a 1-based page number.
 *
 * A missing, blank, negative, or non-numeric value is page 1. A blank value
 * (`?page=`) is a real case rather than a hypothetical: these URLs are built by
 * code that omits empty params, and an omission that produced `?page=` would
 * otherwise render an empty page-1 listing if the parse were strict.
 */
function clampPage(value: string | null): number {
  if (value === null || value.trim() === '') return 1;
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 1;
}

/**
Total pages a collection of `total` entries spans at `limit`.
*/
function pageCountFor(total: number, limit: number): number {
  return total <= 0 ? 1 : Math.max(1, Math.ceil(total / Math.max(1, limit)));
}

/**
Whether a Next control should be enabled.
*/
function hasNextPage(page: number, pageCount: number): boolean {
  return page < pageCount;
}

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PAGE_SIZE_OPTIONS, PAGE_SIZE_STORAGE_KEY, clampPage, clampPageSize, hasNextPage, pageCountFor, readStoredPageSize, storePageSize };
