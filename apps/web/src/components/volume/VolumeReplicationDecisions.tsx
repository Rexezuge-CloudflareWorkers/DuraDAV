import { useTranslation } from 'react-i18next';
import type { ReplicationConflict } from '../../types';
import { Button } from '../ui/Button';

/**
 * The recorded decisions for one target.
 *
 * Both `conflict` and `deletion` rows appear, and that is the point: a two-way sync
 * that deletes on both sides is the most dangerous thing this codebase does, and
 * once a deletion has propagated there is no undo. Recording every one turns "the
 * file is gone" from an archaeology problem into a lookup, and it is the only place
 * a user learns that a conflict copy exists at all.
 */
export function VolumeReplicationDecisions({
  conflicts,
  onResolve,
  onDismiss,
}: {
  conflicts: readonly ReplicationConflict[];
  onResolve: (conflict: ReplicationConflict) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  if (conflicts.length === 0) {
    return (
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-[var(--color-text-primary)]">{t('replication.decisions', 'Recorded Decisions')}</h4>
        <p className="text-sm text-[var(--color-text-muted)]">{t('replication.noDecisions', 'Nothing To Reconcile.')}</p>
        <Button size="sm" variant="secondary" onClick={onDismiss}>
          {t('replication.hideDecisions', 'Hide')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h4 className="text-sm font-medium text-[var(--color-text-primary)]">{t('replication.decisions', 'Recorded Decisions')}</h4>
        <Button size="sm" variant="secondary" onClick={onDismiss}>
          {t('replication.hideDecisions', 'Hide')}
        </Button>
      </div>
      <ul className="space-y-2">
        {conflicts.map((conflict) => (
          <li key={conflict.conflictId} className="rounded-md border border-[var(--color-border)] p-3">
            <p className="text-sm text-[var(--color-text-primary)] break-all">{conflict.path}</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {conflict.kind === 'deletion'
                ? t('replication.deletionPropagated', 'Deletion Propagated. {{winner}} Side Was Removed.', {
                    winner:
                      conflict.winner === 'local'
                        ? t('replication.thisBucket', 'This Bucket')
                        : t('replication.remote', 'Remote'),
                  })
                : t('replication.conflictResolved', 'Both Sides Changed. {{winner}} Side Was Kept.', {
                    winner:
                      conflict.winner === 'local'
                        ? t('replication.thisBucket', 'This Bucket')
                        : t('replication.remote', 'Remote'),
                  })}
            </p>
            {conflict.keptPath !== null && (
              <p className="text-xs text-[var(--color-text-secondary)] break-all">
                {t('replication.keptCopy', 'Other Version Kept At: {{path}}', { path: conflict.keptPath })}
              </p>
            )}
            {conflict.resolvedAt === null && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => onResolve(conflict)}>
                {t('replication.markResolved', 'Mark Resolved')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
