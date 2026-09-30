import type { BucketCredential, CreatedBucketCredential } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

function credentialBase(owner: string, volume: string): string {
  return `/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}/credentials`;
}

export async function listBucketCredentials(owner: string, volume: string): Promise<BucketCredential[]> {
  const data = await apiGet<{ credentials?: BucketCredential[] }>(credentialBase(owner, volume));
  return data.credentials ?? [];
}

export async function createBucketCredential(
  owner: string,
  volume: string,
  name: string,
  expiresInDays?: number,
  readOnly?: boolean,
): Promise<CreatedBucketCredential> {
  return apiPost<CreatedBucketCredential>(credentialBase(owner, volume), { name, expiresInDays, readOnly });
}

export async function setBucketCredentialReadOnly(owner: string, volume: string, credentialId: string, readOnly: boolean): Promise<void> {
  await apiPatch<{ credentialId: string; readOnly: boolean }>(`${credentialBase(owner, volume)}/${encodeURIComponent(credentialId)}`, { readOnly });
}

export async function revokeBucketCredential(owner: string, volume: string, credentialId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(`${credentialBase(owner, volume)}/${encodeURIComponent(credentialId)}`);
}
