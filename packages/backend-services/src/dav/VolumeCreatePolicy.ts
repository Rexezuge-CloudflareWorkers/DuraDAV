import { BadRequestError } from '@durable-dav/backend-errors';
import { DAV_HREF_PREFIX_MODES, isDavHrefPrefixMode } from '@durable-dav/shared/constants';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';

const MAX_VOLUME_DESCRIPTION_LENGTH = 500;

type VolumePatch = { description?: string | null; isPrivate?: boolean; hrefPrefixMode?: DavHrefPrefixMode };

function validateVolumePatch(patch: VolumePatch): void {
  if (typeof patch.description === 'string' && patch.description.length > MAX_VOLUME_DESCRIPTION_LENGTH) {
    throw new BadRequestError('Description must be 500 characters or fewer');
  }
  if (patch.isPrivate !== undefined && typeof patch.isPrivate !== 'boolean') {
    throw new BadRequestError('isPrivate must be a boolean');
  }
  if (patch.hrefPrefixMode !== undefined && !isDavHrefPrefixMode(patch.hrefPrefixMode)) {
    // Fail closed rather than coerce: silently storing an unknown mode would
    // either be rejected by the column CHECK (a 500 on a bad request) or
    // default to `base` behind the caller's back, so the owner would believe
    // they had changed client compatibility and not have.
    throw new BadRequestError(`hrefPrefixMode must be one of: ${DAV_HREF_PREFIX_MODES.join(', ')}`);
  }
}

function checkVolumeQuota(ownedCount: number, max: number): void {
  if (ownedCount >= max) {
    throw new BadRequestError(`Maximum ${max} volumes per user`);
  }
}

export { validateVolumePatch, checkVolumeQuota, MAX_VOLUME_DESCRIPTION_LENGTH };
export type { VolumePatch };
