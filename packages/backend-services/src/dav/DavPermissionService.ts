import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import { isVolumeOwner } from './volumeOwnership';
import type { ViewerIdentity } from './volumeOwnership';

/**
 * The role a viewer holds on a volume.
 *
 * Declared here rather than in `backend-data`: the collaborator/grant model
 * that `DavRole` came from was dropped by migration `0002`, and the permission
 * vocabulary now belongs to the layer that enforces it.
 */
type DavPermission = 'admin' | 'read';

interface DavPermissionServiceEnv {
  DB?: unknown;
}

// Owner-only Policy: owner is implicit admin, public buckets allow anon
// reads, private buckets hide existence. No collaborators, orgs, or grants.
class DavPermissionService {
  constructor(_env?: DavPermissionServiceEnv) {}

  public getRole(viewer: ViewerIdentity | null, volume: DavVolumeRow): Promise<DavPermission | null> {
    const isPrivate = Number(volume.is_private) === 1;
    if (isVolumeOwner(viewer, volume)) return Promise.resolve('admin');
    return isPrivate ? Promise.resolve(null) : Promise.resolve('read');
  }
}

export { DavPermissionService };
export type { DavPermission };
