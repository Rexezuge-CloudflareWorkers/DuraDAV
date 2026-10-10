import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BucketReplication } from '../../types';
import { rotateReplicationCredential } from '../../services/replicationService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Input';

/**
 * Replace one target's stored credential.
 *
 * This exists because the server's answer to a malformed credential used to be an
 * error telling the owner to rotate it — with no way to do so from the browser. The
 * endpoint was there and correct; nothing called it. An instruction the interface
 * cannot act on is worse than a clear failure, because it costs the owner the one
 * thing they cannot get back: time.
 *
 * ## Why the username is asked for again
 *
 * It is stored inside the sealed blob as the `user:` prefix, not in a column of its
 * own, so the server has nothing to carry across a rotation — recovering it would
 * mean decrypting the old credential, which fails exactly when an owner reaches for
 * this. Asking again is the honest cost of that decision, and it is stated here rather
 * than discovered when the rotation 400s.
 *
 * ## Why the password is not trimmed or confirmed
 *
 * The secret is stored verbatim: leading and trailing spaces are part of the password,
 * and trimming one client-side would silently authenticate as something the owner did
 * not type. There is no confirm field either — the owner cannot read the stored value
 * back, so a mismatch between two copies would be indistinguishable from a typo.
 */
export function VolumeReplicationCredentialForm({
  owner,
  volume,
  replication,
  showNotice,
  onDone,
}: {
  owner: string;
  volume: string;
  replication: BucketReplication;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  // A `dav-volume` target is reached over DO RPC and has no credential at all, so
  // there is nothing to rotate and offering the form would be a dead control.
  const [authKind, setAuthKind] = useState<'none' | 'basic' | 'bearer'>(replication.targetKind === 'dav' ? replication.authKind : 'none');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await rotateReplicationCredential(owner, volume, replication.replicationId, {
        authKind,
        username: authKind === 'basic' ? username : '',
        secret: authKind === 'none' ? '' : secret,
      });
      showNotice('success', t('replication.credentialUpdated', 'Credential Updated.'));
      onDone();
    } catch (error) {
      // The server's message verbatim: a `username must not contain ":"` is a
      // constraint on what the remote will accept, and a generic string would leave
      // the owner guessing which of the two fields it was.
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateReplicationCredential', 'Failed To Update Credential.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-[var(--color-border)] p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`replication-rotate-kind-${replication.replicationId}`}>{t('replication.authKind', 'Authentication')}</Label>
        <Select
          id={`replication-rotate-kind-${replication.replicationId}`}
          value={authKind}
          onChange={(e) => setAuthKind(e.target.value as 'none' | 'basic' | 'bearer')}
        >
          <option value="none">{t('replication.authNone', 'None')}</option>
          <option value="basic">{t('replication.authBasic', 'Basic (Username And Password)')}</option>
          <option value="bearer">{t('replication.authBearer', 'Bearer Token')}</option>
        </Select>
      </div>

      {authKind === 'basic' && (
        <div className="space-y-1.5">
          <Label htmlFor={`replication-rotate-username-${replication.replicationId}`}>{t('replication.username', 'Username')}</Label>
          <Input
            id={`replication-rotate-username-${replication.replicationId}`}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      {authKind !== 'none' && (
        <div className="space-y-1.5">
          <Label htmlFor={`replication-rotate-secret-${replication.replicationId}`}>
            {authKind === 'basic' ? t('replication.password', 'Password') : t('replication.token', 'Token')}
          </Label>
          <Input
            id={`replication-rotate-secret-${replication.replicationId}`}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" loading={saving}>
          {t('replication.saveCredential', 'Save Credential')}
        </Button>
        <Button size="sm" type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}