import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from './Logo';

/**
 * Contextual top bar for every non-root page. The global `Header` renders on
 * `/` only; all other routes render this bar instead, with identical
 * geometry (sticky, `max-w-7xl mx-auto px-6`), so the logo/home anchor never
 * moves between pages.
 */
export function ContextBar({ crumb, actions }: { crumb: React.ReactNode; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface-1)]/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-3 flex-wrap">
        <Link to="/" aria-label={t('header.home', 'Durable-DAV Home')} className="shrink-0">
          <Logo />
        </Link>
        <span aria-hidden="true" className="text-[var(--color-text-muted)] font-normal">
          /
        </span>
        <div className="flex items-center gap-2 min-w-0 flex-1">{crumb}</div>
        {actions && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
