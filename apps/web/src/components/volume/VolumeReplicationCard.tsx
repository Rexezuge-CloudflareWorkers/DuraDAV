import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight } from 'lucide-react';
import type { BucketReplication, ReplicationConflict } from '../../types';
import {
  REPLICATION_INTERVALS,
  deleteReplication,
  listReplicationConflicts,
  listReplications,
  resolveReplicationConflict,
  runReplicationNow,
  updateReplication,
} from '../../services/replicationService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { RefreshButton } from '../shared/RefreshButton';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { VolumeReplicationRow } from './VolumeReplicationRow';
import { VolumeReplicationForm } from './VolumeReplicationForm';
import { VolumeReplicationCredentialForm } from './VolumeReplicationCredentialForm';
import { VolumeReplicationDecisions } from './VolumeReplicationDecisions';

/**
 * Per-bucket replication targets.
 *
 * A composer: it owns the fetching, the mutation calls, and which row is expanded.
 * The three presentational pieces are separate components because the three things
 * a user does here — read a target's state, add one, reconcile a decision — have
 * genuinely different concerns and different failure modes.
 *
 * ## Why "Sync now" reports "started"
 *
 * The server detaches the slice into `waitUntil` and answers `202`. That is not an
 * optimisation: a slice can run for tens of seconds, and a client timeout would look
 * like a failed sync that had in fact succeeded. The notice says so explicitly rather
 * than letting the user wonder whether anything happened.
 */
export function VolumeReplicationCard({
  owner,
  volume,
  showNotice,
}: {
  owner: string;
  volume: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [replications, setReplications] = useState<BucketReplication[]>([]);
  const [intervals, setIntervals] = useState<number[]>([...REPLICATION_INTERVALS]);
  const [conflicts, setConflicts] = useState<ReplicationConflict[]>([]);
  /**
   * Which target the decision list belongs to.
   *
   * Tracked rather than carried on each conflict, because the API's conflict
   * projection carries no `replicationId` — the resolve route needs the pair, and
   * inferring it from list order would be a guess.
   */
  const [conflictsFor, setConflictsFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BucketReplication | null>(null);
  /**
   * The target whose credential form is open, if any.
   *
   * At most one: two forms on screen at once invite the owner into re-entering a
   * password into the wrong target, and the stored values are never readable back, so
   * a mistake there is not self-evident.
   */
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const loaded = await listReplications(owner, volume);
        if (cancelled) return;
        setReplications(loaded.replications);
        if (loaded.allowedIntervals.length > 0) setIntervals(loaded.allowedIntervals);
      } catch (error) {
        if (cancelled) return;
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadReplications', 'Failed To Load Replications.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, volume, reloadKey, showNotice, t]);

  const loadConflicts = useCallback(
    async (replicationId: string) => {
      try {
        setConflicts(await listReplicationConflicts(owner, volume, replicationId));
        setConflictsFor(replicationId);
      } catch {
        // A conflict list that fails to load must not clear the target list. The
        // empty state then reads as "none recorded", which is the safe direction to
        // be wrong in — it never claims a decision was made that was not.
        setConflicts([]);
        setConflictsFor(null);
      }
    },
    [owner, volume],
  );

  const syncNow = async (replication: BucketReplication) => {
    setBusyId(replication.replicationId);
    try {
      const result = await runReplicationNow(owner, volume, replication.replicationId);
      showNotice(
        'success',
        result.sync === 'started'
          ? t('replication.syncStarted', 'Sync Started. It Continues In The Background.')
          : t('replication.syncDone', 'Sync Finished.'),
      );
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToRunReplication', 'Failed To Run Sync.'));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (replication: BucketReplication) => {
    setBusyId(replication.replicationId);
    try {
      await updateReplication(owner, volume, replication.replicationId, { enabled: !replication.enabled });
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateReplication', 'Failed To Update Replication.'));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const replicationId = removing.replicationId;
    setRemoving(null);
    setBusyId(replicationId);
    try {
      await deleteReplication(owner, volume, replicationId);
      if (conflictsFor === replicationId) {
        setConflicts([]);
        setConflictsFor(null);
      }
      showNotice('success', t('replication.removed', 'Replication Removed.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDeleteReplication', 'Failed To Remove Replication.'));
    } finally {
      setBusyId(null);
    }
  };

  const resolve = async (conflict: ReplicationConflict) => {
    if (conflictsFor === null) return;
    try {
      await resolveReplicationConflict(owner, volume, conflictsFor, conflict.conflictId);
      await loadConflicts(conflictsFor);
    } catch (error) {
      // The row stays visible on failure, deliberately: it vanishes on success and
      // persists on error, so the owner can retry instead of losing sight of a
      // decision they still need to make.
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToResolveConflict', 'Failed To Mark Resolved.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4" aria-hidden />
            {t('replication.title', 'Replication')}
          </span>
        </CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>

      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t('replication.description', 'Keep This Bucket In Sync With Another WebDAV Server, On A Schedule. Changes Move In Both Directions.')}
        </p>

        {replications.length > 0 ? (
          <ul className="space-y-3">
            {replications.map((replication) => (
              <li key={replication.replicationId} className="space-y-2">
                <VolumeReplicationRow
                  replication={replication}
                  busy={busyId === replication.replicationId}
                  onSyncNow={() => void syncNow(replication)}
                  onToggle={() => void toggle(replication)}
                  onShowDecisions={() => void loadConflicts(replication.replicationId)}
                  onRotateCredential={() => setRotatingId(replication.replicationId)}
                  onRemove={() => setRemoving(replication)}
                />
                {rotatingId === replication.replicationId && (
                  <VolumeReplicationCredentialForm
                    owner={owner}
                    volume={volume}
                    replication={replication}
                    showNotice={showNotice}
                    onDone={() => {
                      setRotatingId(null);
                      refresh();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">{t('replication.none', 'No Replication Targets Yet.')}</p>
        )}

        {conflictsFor !== null && (
          <VolumeReplicationDecisions
            conflicts={conflicts}
            onResolve={(conflict) => void resolve(conflict)}
            onDismiss={() => {
              setConflicts([]);
              setConflictsFor(null);
            }}
          />
        )}

        <VolumeReplicationForm
          owner={owner}
          volume={volume}
          intervals={intervals}
          showNotice={showNotice}
          onSaved={refresh}
        />
      </div>

      {removing !== null && (
        <ConfirmDeleteModal
          title={t('replication.remove', 'Remove')}
          displayName={targetLabelOf(removing)}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}

function targetLabelOf(replication: BucketReplication): string {
  return replication.targetKind === 'dav-volume'
    ? `${replication.remoteOwner}/${replication.remoteVolume}`
    : replication.remoteUrl;
}
