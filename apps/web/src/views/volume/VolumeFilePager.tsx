import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PAGE_SIZE_OPTIONS, hasEntries, hasNextPage, pageCountFor } from '../../lib/davPage';
import { Button } from '../../components/ui/Button';

/**
 * Paging controls for the file listing.
 *
 * Renders nothing when the whole collection fits on one page, so a small folder
 * shows no pager at all rather than a disabled one.
 *
 * `limit` is the limit the **server** applied, not the one the browser asked
 * for — the DO clamps independently (`MAX_PAGE_SIZE`), so a request above it
 * comes back smaller. It used to be passed the browser's own preference, which
 * made the range display disagree with the rows above it whenever the two
 * differed.
 *
 * `entries` is a second, independent gate. A folder that failed to load has no
 * rows and its `total` is meaningless, but the pager used to render on any files
 * tab — so navigating from a 300-entry folder into one that 404'd kept
 * "Page 1 of 3 — 1–100 of 300" on screen under "This Folder Does Not Exist",
 * and Next paged a folder that was not there.
 */
function VolumeFilePager({
  entries,
  page,
  limit,
  total,
  paged,
  onPageChange,
  onPageSizeChange,
}: {
  /**
   * The rows currently displayed. Their absence means there is nothing to page.
   */
  entries: readonly unknown[];
  page: number;
  limit: number;
  /**
  Total entries, or `null` when the server does not page.
  */
  total: number | null;
  /**
  Whether the server pages at all. When false this component renders nothing.
  */
  paged: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (limit: number) => void;
}) {
  const { t } = useTranslation();
  if (!paged || total === null || !hasEntries(entries)) return null;
  const pageCount = pageCountFor(total, limit);
  if (pageCount <= 1) return null;
  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);
  const canGoBack = page > 1;
  const canGoForward = hasNextPage(page, pageCount);

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pt-3 mt-3 border-t border-[var(--color-border)]">
      <p className="text-xs text-[var(--color-text-muted)]" data-testid="volume-pager-range">
        {t('files.pageRange', '{{first}}–{{last}} of {{total}}', { first, last, total })}
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          <span>{t('files.pageSize', 'Per Page')}</span>
          <select
            aria-label={t('files.pageSize', 'Per Page')}
            value={String(limit)}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="px-2 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-xs"
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" size="sm" disabled={!canGoBack} onClick={() => onPageChange(page - 1)} aria-label={t('files.previousPage', 'Previous Page')}>
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('files.previousPage', 'Previous')}
        </Button>
        <span className="text-xs text-[var(--color-text-muted)] tabular-nums">
          {t('files.pageOf', 'Page {{page}} of {{pageCount}}', { page, pageCount })}
        </span>
        <Button variant="secondary" size="sm" disabled={!canGoForward} onClick={() => onPageChange(page + 1)} aria-label={t('files.nextPage', 'Next Page')}>
          {t('files.nextPage', 'Next')}
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export { VolumeFilePager };
