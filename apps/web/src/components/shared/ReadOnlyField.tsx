import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Label } from '../ui/Input';
import { cn } from '../../lib/utils';
import { COPY_FEEDBACK_TIMEOUT_MS } from '../../lib/constants';

export function ReadOnlyField({ label, value, showCopy = false }: { label: string; value: string; showCopy?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // `navigator.clipboard` is absent in an insecure context and its promise
    // rejects on a denied permission, so an unguarded call produced an
    // unhandled rejection *and* showed the checkmark anyway — reporting success
    // for a copy that never happened. This is the copy-once reveal for a bucket
    // credential's password, where a false success means the user walks away
    // believing they have the secret and have not.
    //
    // The guarded/catch form was already correct in `TypeToConfirmModal`; the two
    // copies of this handler had drifted apart.
    const clipboard = globalThis.navigator?.clipboard as Clipboard | undefined;
    if (!clipboard) return;
    void clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        resetTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
      })
      // Leave `copied` false: nothing was copied, so there is nothing to undo.
      .catch(() => undefined);
  };

  // Cleared on unmount. Repeated clicks each replaced the timer before, so an
  // early one could clear the checkmark while a later copy was still pending.
  const resetTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <div>
      <Label className="mb-1.5">{label}</Label>
      <div className="flex">
        <input
          readOnly
          value={value}
          className={cn(
            'min-w-0 px-3 py-2 bg-[var(--color-surface-base)] border border-[var(--color-border)] text-[var(--color-text-secondary)] text-sm flex-1',
            showCopy ? 'rounded-l-lg border-r-0' : 'rounded-lg',
          )}
        />
        {showCopy && (
          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-2 rounded-r-lg bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150"
            title={t('common.copyToClipboard', 'Copy To Clipboard')}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success-text)]" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
