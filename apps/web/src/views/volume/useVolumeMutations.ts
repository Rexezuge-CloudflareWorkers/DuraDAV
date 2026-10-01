import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DavEntry } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { getBackendErrorStatus } from '../../lib/api';
import { parentDavPath, stripSlashes } from '../../lib/davXml';
import { copyEntry, createDirectory, deleteEntry, downloadUrl, moveEntry, uploadFile } from '../../services/davClient';

type NoticeFn = (type: 'success' | 'error', text: string) => void;

/**
 * Hand a file to the browser.
 *
 * Called only after a size gate or a failed preview. Browsers block
 * `window.open` that is not within the transient user-activation window, and
 * every path here is behind at least one `await` — so this can silently do
 * nothing. There is no fix available from here (the tab must be opened
 * synchronously from the click handler, which this hook does not own); what is
 * fixed is that a failure now says so instead of appearing to be a dead button.
 */
function openExternally(url: string): void {
  globalThis.open?.(url, '_blank', 'noopener');
}

/**
 * Did the server refuse because the destination already exists?
 *
 * `412 Precondition Failed` is what COPY/MOVE return for `Overwrite: F` against
 * an existing destination (RFC 4918 §9.9.4), so it is the signal that an
 * overwrite prompt is the right response rather than an error notice.
 */
function isPreconditionFailed(error: unknown): boolean {
  return getBackendErrorStatus(error) === 412;
}

/**
 * A blocked rename or duplicate, awaiting the user's decision to replace.
 *
 * `label` is what the notice names, so the user is told *which* existing entry
 * would go — "replace it?" is not a question anyone can answer.
 */
interface OverwritePrompt {
  kind: 'rename' | 'duplicate';
  from: string;
  to: string;
  label: string;
}

// Mutation slice for file operations (Command pattern: one async action per
// user intent; the view only wires buttons to these commands).
function useVolumeMutations(owner: string, volume: string, path: string, showNotice: NoticeFn, refresh: () => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renaming, setRenaming] = useState<DavEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<DavEntry | null>(null);
  const [preview, setPreview] = useState<{ entry: DavEntry; text: string | null } | null>(null);
  // See `openPreview`: identifies the newest preview request so a slow earlier
  // one cannot overwrite a fast later one.
  const previewRequest = useRef(0);
  const [overwritePrompt, setOverwritePrompt] = useState<OverwritePrompt | null>(null);

  const doMkdir = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const leaf = stripSlashes(mkdirName.trim());
      if (!leaf || leaf.includes('/')) {
        showNotice('error', t('files.invalidFolderName', 'Enter A Single Folder Name.'));
        return;
      }
      setBusy(true);
      try {
        await createDirectory(owner, volume, path === '' ? leaf : `${path}/${leaf}`);
        setMkdirOpen(false);
        setMkdirName('');
        showNotice('success', t('files.folderCreated', 'Folder Created.'));
        refresh();
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateFolder', 'Failed To Create Folder.'));
      } finally {
        setBusy(false);
      }
    },
    [mkdirName, owner, volume, path, refresh, showNotice, t],
  );

  const doUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setBusy(true);
      // Per-file outcomes. The old loop aborted on the first failure, so a
      // 10-file upload where file 7 was over `MAX_FILE_BYTES` reported one
      // generic error, never refreshed, and left the 6 successful uploads
      // invisible — the listing still showed the pre-upload rows. The natural
      // response is to re-select the same 10 files, which re-uploads (and
      // overwrites) the six that had already landed. So each file is reported
      // and the listing is always refreshed, whatever the mix.
      const queue = Array.from(files);
      const failed: string[] = [];
      let succeeded = 0;
      for (const file of queue) {
        const target = path === '' ? file.name : `${path}/${file.name}`;
        try {
          await uploadFile(owner, volume, target, file);
          succeeded += 1;
        } catch (error) {
          failed.push(file.name);
          showNotice('error', `${file.name}: ${toLocalizedErrorMessage(t, error, 'errors.failedToUpload', 'Failed To Upload File.')}`);
        }
      }
      if (succeeded > 0) {
        showNotice('success', t('files.uploaded', 'Upload Complete.'));
      }
      // Even on total failure: the server may have accepted files the browser
      // never saw the answer for, and a stale listing is worse than an empty one.
      refresh();
      setBusy(false);
      if (failed.length > 0 && failed.length === queue.length) {
        showNotice('error', t('errors.failedToUpload', 'Failed To Upload File.'));
      }
    },
    [owner, volume, path, refresh, showNotice, t],
  );

  const doDelete = useCallback(async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteEntry(owner, volume, deleting.path);
      setDeleting(null);
      showNotice('success', t('files.deleted', 'Deleted.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDelete', 'Failed To Delete.'));
    } finally {
      setBusy(false);
    }
  }, [deleting, owner, volume, refresh, showNotice, t]);

  const doRename = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!renaming) return;
      const leaf = stripSlashes(renameValue.trim());
      if (!leaf || leaf.includes('/')) {
        showNotice('error', t('files.invalidName', 'Enter A Single File Or Folder Name.'));
        return;
      }
      const parent = parentDavPath(renaming.path) ?? '';
      const target = parent === '' ? leaf : `${parent}/${leaf}`;
      if (target === renaming.path) {
        setRenaming(null);
        return;
      }
      setBusy(true);
      try {
        // `Overwrite: F` (the `davClient` default): the server refuses to
        // replace an existing destination, so a rename onto an occupied name is
        // a 412 the user is told about rather than a silent delete of whatever
        // was there. Retried once with explicit consent, so the operation is
        // still possible — it just costs a confirmation instead of a decision
        // the user never made.
        await moveEntry(owner, volume, renaming.path, target);
        setRenaming(null);
        showNotice('success', t('files.renamed', 'Renamed.'));
        refresh();
      } catch (error) {
        if (!isPreconditionFailed(error)) {
          showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToRename', 'Failed To Rename.'));
          return;
        }
        setOverwritePrompt({
          kind: 'rename',
          from: renaming.path,
          to: target,
          label: target.slice(target.lastIndexOf('/') + 1),
        });
      } finally {
        setBusy(false);
      }
    },
    [renaming, renameValue, owner, volume, refresh, showNotice, t],
  );

  const doDuplicate = useCallback(
    async (entry: DavEntry) => {
      setBusy(true);
      try {
        await copyEntry(owner, volume, entry.path, `${entry.path}-copy`);
        showNotice('success', t('files.duplicated', 'Duplicated.'));
        refresh();
      } catch (error) {
        if (!isPreconditionFailed(error)) {
          showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDuplicate', 'Failed To Duplicate.'));
          return;
        }
        // A second duplicate of the same entry lands on the same `-copy` name.
        const to = `${entry.path}-copy`;
        setOverwritePrompt({ kind: 'duplicate', from: entry.path, to, label: to.slice(to.lastIndexOf('/') + 1) });
      } finally {
        setBusy(false);
      }
    },
    [owner, volume, refresh, showNotice, t],
  );

  /**
   * The confirmation behind `overwritePrompt`: perform the blocked operation
   * again with `Overwrite: T`.
   */
  const confirmOverwrite = useCallback(async () => {
    if (!overwritePrompt) return;
    const { kind, from, to } = overwritePrompt;
    setOverwritePrompt(null);
    setBusy(true);
    try {
      if (kind === 'rename') await moveEntry(owner, volume, from, to, true);
      else await copyEntry(owner, volume, from, to, true);
      showNotice('success', kind === 'rename' ? t('files.renamed', 'Renamed.') : t('files.duplicated', 'Duplicated.'));
      refresh();
    } catch (error) {
      showNotice(
        'error',
        toLocalizedErrorMessage(t, error, kind === 'rename' ? 'errors.failedToRename' : 'errors.failedToDuplicate', 'Failed To Complete Operation.'),
      );
    } finally {
      setBusy(false);
    }
  }, [overwritePrompt, owner, volume, refresh, showNotice, t]);

  /**
 * Largest body the preview panel will hold in memory (1 MiB).
 */
const MAX_PREVIEW_BYTES = 1_048_576;

const openPreview = useCallback(
    async (entry: DavEntry, openPath: (p: string) => void) => {
      if (entry.isCollection) {
        openPath(entry.path);
        return;
      }
      const url = downloadUrl(owner, volume, entry.path);
      // Monotonic request id. `await fetch` -> `blob()` -> `text()` is three
      // suspension points, so a slow first click could resolve after a fast
      // second and overwrite it — and the modal is labelled from
      // `preview.entry.name`, so it would confidently show the wrong file under
      // the wrong name. `DashboardView` documents and uses this pattern for the
      // same reason; it was missing here.
      const requestId = ++previewRequest.current;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Size gate **before** the body is buffered. The old order was
        // `blob()` then a 1 MiB check, so clicking a 5 GB object transferred and
        // held the whole thing in the tab before deciding not to preview it —
        // a reliable renderer kill on a file the server had happily served.
        // `Content-Length` is advisory (absent on a chunked response), so an
        // oversized-but-unsized body is caught by the post-read check too.
        const declared = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
          openExternally(url);
          return;
        }
        const blob = await response.blob();
        if (blob.size > MAX_PREVIEW_BYTES) {
          openExternally(url);
          return;
        }
        const text = await blob.text().catch(() => null);
        // A superseded request must not land.
        if (requestId !== previewRequest.current) return;
        setPreview({ entry, text });
      } catch (error) {
        // Not swallowed silently any more: the old bare `catch` opened a tab
        // with no notice, so a 404 on a private bucket looked like nothing
        // happened.
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadFiles', 'Failed To Load Files.'));
        openExternally(url);
      }
    },
    [owner, volume, showNotice, t],
  );

  return {
    busy,
    mkdirOpen,
    setMkdirOpen,
    mkdirName,
    setMkdirName,
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    deleting,
    setDeleting,
    preview,
    setPreview,
    doMkdir,
    doUpload,
    doDelete,
    doRename,
    doDuplicate,
    openPreview,
    overwritePrompt,
    cancelOverwrite: () => setOverwritePrompt(null),
    confirmOverwrite,
  };
}

export { useVolumeMutations };
