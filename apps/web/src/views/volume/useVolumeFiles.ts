import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DavEntry } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { listDirectory } from '../../services/davClient';
import { pageCountFor } from '../../lib/davPage';

// Data-fetching slice for the file browser (why: `VolumeView` mixed routing,
// fetching, and mutations; isolating the query keeps the view a thin
// composition root like `SpaApp`).
function useVolumeFiles(owner: string, volume: string, path: string, requestedPage: number, pageSize: number) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DavEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Server-authoritative paging. `total` is null when the server does not page,
  // which is what switches the view to slicing the full listing client-side.
  const [paging, setPaging] = useState<{ page: number; pageCount: number; total: number | null; paged: boolean }>({
    page: 1,
    pageCount: 1,
    total: null,
    paged: false,
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // Reset to loading on every fetch, not just on an explicit `refresh()`.
      // Navigating to another folder re-ran this effect while `status` was
      // still `ready`, so the *previous* folder's rows stayed on screen until
      // the new PROPFIND resolved.
      setStatus('loading');
      // Drop the previous folder's rows too, not just the status. `VolumeFileList`
      // gates its not-found state on `entries.length === 0`, so a *failed*
      // PROPFIND left `status: 'missing'` alongside the old rows and rendered
      // them under the new breadcrumb — the previous folder's files displayed as
      // if they lived in the folder that just failed to load.
      setEntries([]);
      try {
        const rows = await listDirectory(owner, volume, path, { page: requestedPage, limit: pageSize });
        if (cancelled) return;
        setEntries(rows.entries);
        setPaging({
          page: rows.page,
          pageCount: rows.total === null ? 1 : pageCountFor(rows.total, rows.limit),
          total: rows.total,
          paged: rows.paged,
        });
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        setStatus('missing');
        setNotice({ type: 'error', text: toLocalizedErrorMessage(t, error, 'errors.failedToLoadFiles', 'Failed To Load Files.') });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // `authorized` is deliberately not a dependency: it is not read here, and
    // including it made the effect fire twice per cold load (once
    // speculatively while auth was still resolving, once after) for an
    // identical request.
  }, [owner, volume, path, requestedPage, pageSize, reloadKey, t]);

  const refresh = useCallback(() => {
    setStatus('loading');
    setReloadKey((k) => k + 1);
  }, []);

  // Stable identity: a fresh arrow on every render made the caller's effect
  // re-run after every render, re-firing `showNotice` and restarting its
  // dismissal timer, which could make an error toast undismissable.
  const consumeNotice = useCallback(() => setNotice(null), []);

  const crumbs = path === '' ? [] : path.split('/');

  return { entries, status, refresh, crumbs, notice, consumeNotice, paging };
}

export { useVolumeFiles };
