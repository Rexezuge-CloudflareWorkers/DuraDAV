import { useTranslation } from 'react-i18next';
import type { BucketReplication } from '../../types';
import { intervalLabel, targetLabel } from '../../services/replicationService';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  ok: 'success',
  partial: 'warning',
  failed: 'error',
};

function statusVariant(status: BucketReplication['lastStatus']): 'success' | 'warning' | 'error' | 'neutral' {
  return STATUS_VARIANTS[status ?? 'pending'] ?? 'neutral';
}

const STATUS_LABELS = {
  ok: ['replication.statusOk', 'Up To Date'],
  partial: ['replication.statusPartial', 'Partially Synced'],
  failed: ['replication.statusFailed', 'Failed'],
  pending: ['replication.statusPending', 'Not Synced Yet'],
} as const;

function statusLabel(t: (key: string, fallback: string) => string, status: BucketReplication['lastStatus']): string {
  const [key, fallback] = STATUS_LABELS[status ?? 'pending'];
  return t(key, fallback);
}

/**
 * One configured target, with its last run's outcome.
 *
 * Split out of the card so the card stays a composer. Every row explains *why* it
 * looks the way it does, because the alternative is a list of badges a user cannot
 * act on: an open pass means deletions are deliberately held back, and a run of
 * failures means the target has probably been auto-disabled.
 *
 * A `<div>`, not the `<li>` it used to be: the card now wraps each row together with
 * its credential form in one `<li>`, and a list item nested inside a list item is
 * invalid HTML that browsers silently re-parent.
 */
export function VolumeReplicationRow({
  replication,
  busy,
  onSyncNow,
  onToggle,
  onShowDecisions,
  onRotateCredential,
  onRemove,
}: {
  replication: BucketReplication;
  busy: boolean;
  onSyncNow: () => void;
  onToggle: () => void;
  onShowDecisions: () => void;
  onRotateCredential: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3 space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-text-primary)] break-all">{targetLabel(replication)}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('replication.every', 'Every {{interval}}', { interval: intervalLabel(replication.intervalMinutes) })} ·{' '}
            {t(`replication.mode.${replication.mode}`, replication.mode)}
            {/*
              A badge rather than another line of prose, because "exact mirror" is the
              single fact about a `pull-only` target that determines what the owner
              must not do here — it is the only configuration in which a sync can
              delete a file this bucket holds.
            */}
            {replication.mode === 'pull-only' && (
              <Badge variant={replication.mirrorDeletions ? 'warning' : 'neutral'}>
                {replication.mirrorDeletions
                  ? t('replication.exactMirror', 'Exact Mirror')
                  : t('replication.safeCopy', 'Safe Copy')}
              </Badge>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(replication.lastStatus)}>{statusLabel(t, replication.lastStatus)}</Badge>
          {!replication.enabled && <Badge variant="neutral">{t('replication.disabled', 'Paused')}</Badge>}
        </div>
      </div>

      {replication.lastError !== null && replication.lastError !== '' && (
        <p className="text-xs text-[var(--color-error-text)] break-all">{replication.lastError}</p>
      )}

      {replication.passInFlight && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(
            'replication.passInFlight',
            'A Sync Pass Is In Progress. Deletions Propagate Only After A Pass Finishes Without Errors.',
          )}
        </p>
      )}

      {replication.consecutiveFailures > 0 && (
        <p className="text-xs text-[var(--color-warning-text)]">
          {t('replication.consecutiveFailures', '{{count}} Consecutive Failed Attempts', { count: replication.consecutiveFailures })}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" loading={busy} onClick={onSyncNow}>
          {t('replication.syncNow', 'Sync Now')}
        </Button>
        <Button size="sm" variant="secondary" loading={busy} onClick={onToggle}>
          {replication.enabled ? t('replication.pause', 'Pause') : t('replication.resume', 'Resume')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onShowDecisions}>
          {t('replication.showConflicts', 'Show Decisions')}
        </Button>
        {/*
          Only for a `dav` target: a `dav-volume` target is reached over DO RPC and
          carries no credential, so a rotate control there would promise something the
          server has no field to store.
        */}
        {replication.targetKind === 'dav' && (
          <Button size="sm" variant="secondary" onClick={onRotateCredential}>
            {t('replication.rotateCredential', 'Update Credential')}
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={onRemove}>
          {t('replication.remove', 'Remove')}
        </Button>
      </div>
    </div>
  );
}
