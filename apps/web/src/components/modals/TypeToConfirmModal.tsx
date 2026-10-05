import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { ModalShell } from './ModalShell';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

export function TypeToConfirmModal({
  title,
  description,
  expectedName,
  confirmLabel,
  onConfirm,
  onCancel,
  loading = false,
}: {
  title: string;
  description: string;
  expectedName: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const { copied, copy } = useCopyToClipboard();

  const matched = input.trim() === expectedName;

  return (
    <ModalShell onClose={onCancel} widthClass="w-full max-w-md mx-4" ariaLabel={title}>
      <div className="p-6">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-error-bg)] mb-4 mx-auto">
          <AlertTriangle className="h-5 w-5 text-[var(--color-error-text)]" />
        </div>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] text-center mb-2">{title}</h2>
        <p className="text-sm text-[var(--color-text-secondary)] text-center mb-4">{description}</p>
        <div className="flex items-center justify-center gap-2 mb-4">
          <code className="px-2.5 py-1.5 rounded-lg bg-[var(--color-surface-base)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] break-all">
            {expectedName}
          </code>
          <button
            type="button"
            onClick={() => copy(expectedName)}
            title={t('common.copyToClipboard', 'Copy To Clipboard')}
            aria-label={t('common.copyToClipboard', 'Copy To Clipboard')}
            className="px-2.5 py-2 rounded-lg bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success-text)]" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="space-y-1.5 mb-6">
          <Label htmlFor="danger-confirm-input">{t('common.typeToConfirm', 'Type {{name}} To Confirm', { name: expectedName })}</Label>
          <Input
            id="danger-confirm-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={expectedName}
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="flex gap-3">
          <Button
            variant="ghost"
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            disabled={!matched}
            loading={loading}
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
