import type { DavHrefPrefixMode, Volume, VolumeDetail } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

type VolumeJson = {
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  hrefPrefixMode: DavHrefPrefixMode;
  href: string;
};

function toVolume(data: VolumeJson): Volume {
  return {
    owner: data.owner,
    name: data.name,
    fullName: `${data.owner}/${data.name}`,
    description: data.description,
    isPrivate: data.isPrivate,
    hrefPrefixMode: data.hrefPrefixMode,
    href: data.href,
  };
}

export async function listMyVolumes(): Promise<Volume[]> {
  const data = await apiGet<{ volumes?: VolumeJson[] }>('/user/volumes');
  return (data.volumes ?? []).map(toVolume);
}

export async function loadVolume(owner: string, volume: string): Promise<VolumeDetail> {
  const data = await apiGet<VolumeJson>(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`);
  return { ...toVolume(data), description: data.description };
}

export async function updateVolume(
  owner: string,
  volume: string,
  patch: { description?: string | null; isPrivate?: boolean; hrefPrefixMode?: DavHrefPrefixMode },
): Promise<VolumeDetail> {
  const data = await apiPatch<VolumeJson>(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`, patch);
  return { ...toVolume(data), description: data.description };
}

export async function createVolume(input: {
  owner?: string;
  name: string;
  description?: string | null;
  isPrivate?: boolean;
  hrefPrefixMode?: DavHrefPrefixMode;
}): Promise<Volume> {
  const created = await apiPost<{ owner: string; name: string; href: string }>('/user/volumes', {
    ...input,
    isPrivate: input.isPrivate ?? true,
  });
  return {
    owner: created.owner,
    name: created.name,
    fullName: `${created.owner}/${created.name}`,
    isPrivate: input.isPrivate ?? true,
    // The create response does not echo the row's columns, so report what was
    // asked for. The dashboard refetches the bucket before showing its settings.
    hrefPrefixMode: input.hrefPrefixMode ?? 'base',
    href: created.href,
  };
}

export async function deleteVolume(owner: string, volume: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/user/volumes/${encodeURIComponent(owner)}/${encodeURIComponent(volume)}`);
}
