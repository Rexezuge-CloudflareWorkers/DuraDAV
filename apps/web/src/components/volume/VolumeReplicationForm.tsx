import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Input';
import { createReplication } from '../../services/replicationService';
import type { CreateReplicationInput } from '../../services/replicationService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

const MODES = ['keep-both', 'sync', 'copy-only'] as const;

/**
 * What each mode will and will not do.
 *
 * In the form rather than behind a docs link, because `copy-only` and `keep-both`
 * differ in a way a user has to be told about *before* choosing: one of them will
 * delete files on the remote, and the other will never overwrite anything.
 */
function modeExplanation(t: (key: string, fallback: string) => string, mode: (typeof MODES)[number]): string {
  const HELP = {
    'copy-only': [
      'replication.modeHelp.copyOnly',
      'One Way: This Bucket Is The Only Writer. Changes On The Remote Are Ignored, And Deletions Here Remove Them There.',
    ],
    sync: [
      'replication.modeHelp.sync',
      'Two Way. If Both Sides Change The Same File, The Newer Version Wins — Compared By Timestamp, Which Is Each Server’s Own Clock.',
    ],
    'keep-both': [
      'replication.modeHelp.keepBoth',
      'Two Way. If Both Sides Change The Same File, Neither Is Overwritten: The Other Version Is Saved Beside It As A Conflict Copy.',
    ],
  } as const;
  const [key, fallback] = HELP[mode];
  return t(key, fallback);
}

/**
 * The add-a-target form.
 *
 * `targetKind` drives which fields are rendered at all, so a URL for a sibling
 * bucket — or an owner and volume for an external server — cannot even be
 * submitted. The server validates the same distinctions again; this only saves the
 * user from being told they are wrong.
 *
 * The intervals are the server's list, fetched with the targets and passed in. A
 * `<select>` whose value matches no `<option>` renders blank, so the local constant
 * is only ever a fallback for the very first paint.
 */
export function VolumeReplicationForm({
  owner,
  volume,
  intervals,
  showNotice,
  onSaved,
}: {
  owner: string;
  volume: string;
  intervals: number[];
  showNotice: (type: 'success' | 'error', text: string) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [targetKind, setTargetKind] = useState<'dav' | 'dav-volume'>('dav');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteOwner, setRemoteOwner] = useState('');
  const [remoteVolume, setRemoteVolume] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [authKind, setAuthKind] = useState<'none' | 'basic' | 'bearer'>('none');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [mode, setMode] = useState<(typeof MODES)[number]>('keep-both');
  const [chosenInterval, setChosenInterval] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Derived during render rather than corrected in an effect. The server list
  // arrives after the first paint, and an interval it will reject is worse than one
  // it will not — so a choice the user never made is always replaced by an offered
  // one, while a choice they did make survives the list arriving.
  //
  // `intervals[1]` rather than `[0]`: the first offered interval is 15 minutes, which
  // is aggressive as a default for a job that can move every file in a bucket.
  const intervalMinutes =
    chosenInterval !== null && intervals.includes(chosenInterval) ? chosenInterval : (intervals[1] ?? intervals[0] ?? 360);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const input: CreateReplicationInput = {
      targetKind,
      remoteUrl: targetKind === 'dav' ? remoteUrl.trim() : '',
      remoteOwner: targetKind === 'dav-volume' ? remoteOwner.trim() : '',
      remoteVolume: targetKind === 'dav-volume' ? remoteVolume.trim() : '',
      remotePath: remotePath.trim(),
      authKind: targetKind === 'dav' ? authKind : 'none',
      username: authKind === 'basic' ? username.trim() : '',
      secret: authKind === 'none' ? '' : secret,
      mode,
      intervalMinutes,
    };
    try {
      await createReplication(owner, volume, input);
      setRemoteUrl('');
      setRemoteOwner('');
      setRemoteVolume('');
      setRemotePath('');
      setSecret('');
      showNotice('success', t('replication.created', 'Replication Added.'));
      onSaved();
    } catch (error) {
      // The server's message verbatim. An egress-policy rejection ("must use
      // https", "is not a public address") is the single most likely failure here,
      // and a generic string would leave the owner with nothing to act on.
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateReplication', 'Failed To Add Replication.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 border-t border-[var(--color-border)] pt-4">
      <h4 className="text-sm font-medium text-[var(--color-text-primary)]">{t('replication.addTarget', 'Add A Target')}</h4>

      <div className="space-y-1.5">
        <Label htmlFor="replication-target-kind">{t('replication.targetKind', 'Target Type')}</Label>
        <Select id="replication-target-kind" value={targetKind} onChange={(e) => setTargetKind(e.target.value as 'dav' | 'dav-volume')}>
          <option value="dav">{t('replication.targetDav', 'Another WebDAV Server')}</option>
          <option value="dav-volume">{t('replication.targetVolume', 'A Bucket On This Server')}</option>
        </Select>
      </div>

      {targetKind === 'dav' ? (
        <div className="space-y-1.5">
          <Label htmlFor="replication-url">{t('replication.remoteUrl', 'Server URL')}</Label>
          <Input
            id="replication-url"
            type="url"
            placeholder="https://cloud.example.com/remote.php/dav/files/me/backup"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('replication.httpsOnly', 'Https Only. Loopback And Private Network Addresses Are Blocked Unless The Operator Has Allowed Them.')}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="replication-remote-owner">{t('replication.remoteOwner', 'Bucket Owner')}</Label>
            <Input id="replication-remote-owner" value={remoteOwner} onChange={(e) => setRemoteOwner(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="replication-remote-volume">{t('replication.remoteVolume', 'Bucket Name')}</Label>
            <Input id="replication-remote-volume" value={remoteVolume} onChange={(e) => setRemoteVolume(e.target.value)} />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="replication-remote-path">{t('replication.remotePath', 'Subdirectory (Optional)')}</Label>
        <Input id="replication-remote-path" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="backups/bucket" />
      </div>

      {targetKind === 'dav' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="replication-auth-kind">{t('replication.authKind', 'Authentication')}</Label>
            <Select id="replication-auth-kind" value={authKind} onChange={(e) => setAuthKind(e.target.value as 'none' | 'basic' | 'bearer')}>
              <option value="none">{t('replication.authNone', 'None')}</option>
              <option value="basic">{t('replication.authBasic', 'Basic (Username And Password)')}</option>
              <option value="bearer">{t('replication.authBearer', 'Bearer Token')}</option>
            </Select>
          </div>

          {authKind === 'basic' && (
            <div className="space-y-1.5">
              <Label htmlFor="replication-username">{t('replication.username', 'Username')}</Label>
              <Input id="replication-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </div>
          )}

          {authKind !== 'none' && (
            <div className="space-y-1.5">
              <Label htmlFor="replication-secret">
                {authKind === 'basic' ? t('replication.password', 'Password') : t('replication.token', 'Token')}
              </Label>
              <Input
                id="replication-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-[var(--color-text-muted)]">
                {t(
                  'replication.secretStored',
                  'Stored Encrypted With The Server Key. It Is Never Shown Again — Change It By Adding A New Target.',
                )}
              </p>
            </div>
          )}
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="replication-mode">{t('replication.mode', 'Sync Mode')}</Label>
          <Select id="replication-mode" value={mode} onChange={(e) => setMode(e.target.value as (typeof MODES)[number])}>
            {MODES.map((option) => (
              <option key={option} value={option}>
                {t(`replication.mode.${option}`, option)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="replication-interval">{t('replication.interval', 'Interval')}</Label>
          <Select id="replication-interval" value={String(intervalMinutes)} onChange={(e) => setChosenInterval(Number(e.target.value))}>
            {intervals.map((option) => (
              <option key={option} value={String(option)}>
                {option}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">{modeExplanation(t, mode)}</p>

      <div>
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {t('replication.add', 'Add Replication')}
        </Button>
      </div>
    </form>
  );
}
