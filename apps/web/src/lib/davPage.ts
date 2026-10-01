/**
 * Client-side paging for the bucket browser.
 *
 * The page number lives in the URL (`?page=`), next to the existing `?path=`,
 * so a folder+page link is shareable and survives refresh and back/forward. The
 * page *size* is a preference rather than navigation state, so it lives in
 * `localStorage` instead — which is also what keeps a size change from being
 * purely cosmetic. It is not that putting it in the URL "would make every size
 * change push a history entry": `changePageSize` resets to page 1 through the
 * same `setPath` a folder change uses, which pushes, because discarding pages
 * 2..N of the collection you are reading is a real navigation. The URL carries
 * the position; storage carries the presentation.
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
    return raw == null ? DEFAULT_PAGE_SIZE : nearestOfferedPageSize(clampPageSize(raw));
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
 * Clamp a page size to a value the UI can actually render.
 *
 * No minimum beyond the offered options. A small page is a legitimate request —
 * a script listing 10 entries at a time, a test asserting a page boundary — so
 * clamping *up* to a UI-shaped default would silently answer a different
 * question than the one asked. But a size the `<select>` does not offer is not
 * that: `readStoredPageSize` feeds it directly, and React's controlled
 * `<select>` renders blank (`selectedIndex === -1`) when its value matches no
 * `<option>`. A persisted `1` therefore produced an empty dropdown, a range
 * reading "1–1 of 12 431", and no way to see what was wrong — durable across
 * sessions until the control happened to be touched.
 *
 * So `readStoredPageSize` snaps to the nearest offered size (below this
 * function) and this stays a pure numeric clamp for programmatic callers.
 */
function clampPageSize(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  const truncated = Math.trunc(raw);
  return truncated <= 0 ? DEFAULT_PAGE_SIZE : Math.min(truncated, MAX_PAGE_SIZE);
}

/**
 * Snap a stored preference to a size the selector offers.
 *
 * The value is durable and unvalidated: any user (or another tab, or a
 * hand-edited key) can put an arbitrary number in `localStorage`, and `Number`
 * happily accepts `'0x10'` and `'1e1'`. Everything not exactly on an offered
 * option lands on the nearest one above it, or the default when there is none.
 */
function nearestOfferedPageSize(value: number): number {
  if (PAGE_SIZE_OPTIONS.includes(value)) return value;
  for (const option of PAGE_SIZE_OPTIONS) {
    if (option >= value) return option;
  }
  // Above every offered size, which `clampPageSize` has already ruled out — but
  // a future option list could make it reachable, and returning a value the
  // `<select>` has no `<option>` for is the bug this function exists to prevent.
  // Computed rather than indexed so the answer does not depend on the list being
  // sorted.
  let largest = DEFAULT_PAGE_SIZE;
  for (const option of PAGE_SIZE_OPTIONS) {
    if (option > largest) largest = option;
  }
  return largest;
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
/**
 * Does a page hold entries that are still there to display?
 *
 * False for the state where showing a pager is a lie: a folder that failed to
 * load. `VolumeView` gated the pager on `activeTab === 'files'` alone, so
 * navigating from a 300-entry folder into one that 404'd left "Page 1 of 3 —
 * 1-100 of 300" sitting under the message "This Folder Does Not Exist", and
 * Next then set `?page=2` on a folder that was not there.
 */
function hasEntries(entries: readonly unknown[]): boolean {
  return entries.length > 0;
}

function pageCountFor(total: number, limit: number): number {
  return total <= 0 ? 1 : Math.max(1, Math.ceil(total / Math.max(1, limit)));
}

/**
Whether a Next control should be enabled.
*/
function hasNextPage(page: number, pageCount: number): boolean {
  return page < pageCount;
}

/**
 * Is the URL's page ahead of the listing currently resolved on screen?
 *
 * Without this the correction effect below could not tell a stale share link
 * from a Next the user just clicked, because both are "URL page != resolved
 * page". It runs in the same commit the click produces, in the *pre-update*
 * closure — so on every click it saw `paging.page = 1`, `page = 2` and called
 * `setPage(1)`, undoing the click. The PROPFIND then resolved and pushed `?page=2`
 * a second time: two identical requests per page change, and a history stack of
 * `[…, base, ?page=2, base, ?page=2]` where the first Back press appeared to do
 * nothing. The effect could also only distinguish a correction from a navigation
 * at all by the value of `page === 1`, so the documented case (`?page=5`
 * corrected to page 3) pushed an entry the pager's own comment says it must not.
 *
 * True only while a correction is genuinely pending: rows settled, server paged,
 * URL and listing disagree, and the URL is the one being corrected *to* the
 * server's answer — i.e. the URL is ahead of what has been fetched, which is
 * exactly the stale-link case.
 */
function hasPendingPageCorrection(args: {
  status: string;
  paged: boolean;
  requestedPage: number;
  resolvedPage: number;
  requestedLimit: number;
  resolvedLimit: number;
}): boolean {
  if (args.status !== 'ready' || !args.paged || args.requestedPage === args.resolvedPage) return false;
  // A different page *size* also makes the two disagree, and that is handled by
  // resetting to page 1 rather than correcting.
  return args.requestedLimit === args.resolvedLimit && args.requestedPage > args.resolvedPage;
}

export { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, clampPage, clampPageSize, hasEntries, hasNextPage, hasPendingPageCorrection, pageCountFor, readStoredPageSize, storePageSize };
