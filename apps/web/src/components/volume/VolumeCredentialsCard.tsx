import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import type { BucketCredential } from '../../types';
import { createBucketCredential, listBucketCredentials, revokeBucketCredential, setBucketCredentialReadOnly } from '../../services/credentialService';
import { formatExpiryTimestamp } from '../../lib/format';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ReadOnlyField } from '../shared/ReadOnlyField';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

export function VolumeCredentialsCard({
  owner,
  volume,
  showNotice,
}: {
  owner: string;
  volume: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState<BucketCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ username: string; password: string; readOnly: boolean } | null>(null);
  const [revoking, setRevoking] = useState<BucketCredential | null>(null);
  const [flipping, setFlipping] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const rows = await listBucketCredentials(owner, volume);
        if (cancelled) return;
        setCredentials(rows);
      } catch (error) {
        if (cancelled) return;
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadCredentials', 'Failed To Load Credentials.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, volume, reloadKey, showNotice, t]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const expiry = expiresInDays.trim() === '' ? undefined : Number(expiresInDays);
    if (expiry !== undefined && (!Number.isSafeInteger(expiry) || expiry <= 0)) {
      showNotice('error', t('credentials.invalidExpiry', 'Expiry Must Be A Positive Number Of Days.'));
      return;
    }
    setSaving(true);
    try {
      const created = await createBucketCredential(owner, volume, name.trim(), expiry, readOnly);
      setLastCreated({ username: created.username, password: created.password, readOnly: created.readOnly });
      setName('');
      setExpiresInDays('');
      setReadOnly(false);
      showNotice('success', t('credentials.created', 'Credential Created. Copy The Password Now — It Will Not Be Shown Again.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateCredential', 'Failed To Create Credential.'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Flip a credential between read-only and full access.
   *
   * Optimistic: the row is patched locally first so the badge does not lag a
   * network round trip, and reverted from the server's answer on failure. The
   * credential is a bearer secret the client has already cached, so the server
   * cannot force the client to forget it — this toggle is a policy statement
   * that takes effect on the next request the client makes.
   */
  const toggleReadOnly = async (cred: BucketCredential) => {
    const next = !cred.readOnly;
    setFlipping(cred.credentialId);
    setCredentials((rows) => rows.map((row) => (row.credentialId === cred.credentialId ? { ...row, readOnly: next } : row)));
    try {
      await setBucketCredentialReadOnly(owner, volume, cred.credentialId, next);
      showNotice('success', next ? t('credentials.nowReadOnly', 'Credential Is Now Read-Only.') : t('credentials.nowReadWrite', 'Credential Can Now Write.'));
    } catch (error) {
      setCredentials((rows) => rows.map((row) => (row.credentialId === cred.credentialId ? { ...row, readOnly: cred.readOnly } : row)));
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateCredential', 'Failed To Update Credential.'));
    } finally {
      setFlipping(null);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeBucketCredential(owner, volume, revoking.credentialId);
      showNotice('success', t('credentials.revoked', 'Credential Revoked.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToRevokeCredential', 'Failed To Revoke Credential.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('credentials.bucketCredentials', 'Bucket Credentials')}</CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>
      <p className="text-sm text-[var(--color-text-secondary)] mb-3">
        {t('credentials.hint', 'Each Credential Unlocks Only This Bucket. Use The Generated Username And Password As WebDAV Basic Auth.')}
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <Input
              placeholder={t('credentials.namePlaceholder', 'Credential Name (e.g. laptop)')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="w-32">
            <Input
              placeholder={t('credentials.expiryPlaceholder', 'Expiry (days)')}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]" title={t('credentials.readOnlyHint', 'Can Browse And Download, But Cannot Upload, Delete, Or Rename.')}>
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            {t('credentials.readOnly', 'Read-Only')}
          </label>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            <KeyRound className="h-3.5 w-3.5" />
            {t('credentials.create', 'Create Credential')}
          </Button>
        </div>
      </form>
      {lastCreated && (
        <div className="mt-4 space-y-2">
          <ReadOnlyField label={t('credentials.newUsername', 'New Username')} value={lastCreated.username} showCopy />
          <ReadOnlyField label={t('credentials.newPassword', 'New Password (Copy Once)')} value={lastCreated.password} showCopy />
          {lastCreated.readOnly && (
            <Badge variant="info">{t('credentials.readOnlyBadge', 'Read-Only Access')}</Badge>
          )}
        </div>
      )}
      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {credentials.map((cred) => (
          <li key={cred.credentialId} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="font-medium text-[var(--color-text-primary)] truncate">
                {cred.name}
                <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)]">
                  {cred.username} · {cred.passwordPrefix}…{cred.passwordLastFour}
                </span>
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {formatExpiryTimestamp(cred.expiresAt)}
                {cred.readOnly && <span className="ml-2">{t('credentials.readOnlyBadge', 'Read-Only Access')}</span>}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="secondary" size="sm" loading={flipping === cred.credentialId} onClick={() => void toggleReadOnly(cred)}>
                {cred.readOnly ? t('credentials.allowWrites', 'Allow Writes') : t('credentials.makeReadOnly', 'Make Read-Only')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setRevoking(cred)}>
                {t('credentials.revoke', 'Revoke')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {credentials.length === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('credentials.empty', 'No Credentials Yet.')}</p>
      )}
      {revoking && (
        <ConfirmDeleteModal
          title={t('credentials.revokeCredential', 'Revoke Credential')}
          displayName={revoking.name}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </Card>
  );
}
