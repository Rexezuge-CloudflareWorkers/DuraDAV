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

// Owner-only Policy: owner is implicit admin, public buckets allow anon reads,
// private buckets hide existence. No collaborators, orgs, or grants.
//
// No constructor, and no `env` parameter. The previous signature took one and
// ignored it (`_env`), so every call site and the DI binding had to supply an
// argument that was never read — and the shape implied a dependency this class
// does not have. `getRole` is genuinely synchronous (two comparisons over a row
// already in hand), so it is not wrapped in a resolved promise either: the
// `await` at each call site already works on a non-promise, and the wrapper only
// obscured that.
class DavPermissionService {
  public getRole(viewer: ViewerIdentity | null, volume: DavVolumeRow): DavPermission | null {
    const isPrivate = Number(volume.is_private) === 1;
    if (isVolumeOwner(viewer, volume)) return 'admin';
    return isPrivate ? null : 'read';
  }
}

export { DavPermissionService };
export type { DavPermission };
