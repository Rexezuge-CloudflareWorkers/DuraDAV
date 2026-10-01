import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';

/**
 * "A file with that name already exists. Replace it?"
 *
 * Rename and duplicate send `Overwrite: F`, so the server refuses to replace an
 * occupied destination and answers 412. That refusal is the whole point: with
 * `Overwrite: T` (the previous default) the DO's COPY/MOVE removed the
 * destination *before* creating the source, so renaming `a.txt` to `b.txt`
 * deleted `b.txt` and its contents with no prompt and no undo — while the SPA
 * gates every other irreversible action (bucket delete behind a
 * type-to-confirm, entry delete behind a confirmation).
 *
 * `label` is what the prompt names, because "replace it?" is not a question
 * anyone can answer without knowing *what*.
 */
function VolumeOverwritePrompt({
  name,
  busy,
  onConfirm,
  onCancel,
}: {
  /**
   * The entry that would be deleted, by display name.
   */
  name: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
      <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('files.replaceTitle', 'Replace Existing Entry?')}</h2>
        <div className="flex gap-2 flex-wrap">
          <Button variant="danger" size="sm" disabled={busy} onClick={onConfirm}>
            {t('files.replaceConfirm', 'Replace It')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
            {t('files.replaceCancel', 'Keep Both')}
          </Button>
        </div>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        {t('files.replaceExplain', '{{name}} Already Exists And Will Be Deleted.', { name })}
      </p>
    </div>
  );
}

export { VolumeOverwritePrompt };