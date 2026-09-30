import { BadRequestError } from '@durable-dav/backend-errors';
import { DAV_HREF_PREFIX_MODES, isDavHrefPrefixMode } from '@durable-dav/shared/constants';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';

const MAX_VOLUME_DESCRIPTION_LENGTH = 500;

/**
The validated shape: what a `dav_volumes` row can actually hold.
*/
type VolumePatch = { description?: string | null; isPrivate?: boolean; hrefPrefixMode?: DavHrefPrefixMode };

/**
 * The *unvalidated* shape: anything a parsed JSON body can hold.
 *
 * The validator's parameter is this, not {@link VolumePatch}. Typing it as the
 * already-valid type is what let `POST { isPrivate: "false" }` through — the
 * compiler treated the value as a boolean, so the runtime check had nothing
 * left to catch.
 */
type VolumePatchInput = { description?: unknown; isPrivate?: unknown; hrefPrefixMode?: unknown };

/**
 * The single owner of the volume-write validation rules, shared by create and
 * PATCH. Returns the narrowed value so a caller never has to cast the result
 * of its own validation.
 *
 * Every field is checked by *type* before its *value*, because each has a way
 * to turn a wrong type into a silent security or data outcome rather than a
 * 500:
 *
 * - `isPrivate` — the string `"false"` reaches the auth layer as
 *   `Number("false") === 1 ? private : public`, i.e. **public**. A caller who
 *   asked for a private bucket and sent the wrong type would get a public one.
 * - `description` — an object or number would be stored verbatim into a `TEXT`
 *   column, making `VolumeJson.description` a type lie.
 * - `hrefPrefixMode` — the column has a `CHECK`, so an unknown value is either a
 *   500 on a bad request or a silent default to `base` behind the caller's back,
 *   and the owner would believe they had changed client compatibility and not
 *   have.
 */
function parseVolumePatch(input: VolumePatchInput): VolumePatch {
  if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
    throw new BadRequestError('Description must be a string or null');
  }
  if (typeof input.description === 'string' && input.description.length > MAX_VOLUME_DESCRIPTION_LENGTH) {
    throw new BadRequestError(`Description must be ${MAX_VOLUME_DESCRIPTION_LENGTH} characters or fewer`);
  }
  if (input.isPrivate !== undefined && typeof input.isPrivate !== 'boolean') {
    throw new BadRequestError('isPrivate must be a boolean');
  }
  if (input.hrefPrefixMode !== undefined && !isDavHrefPrefixMode(input.hrefPrefixMode)) {
    // Fail closed rather than coerce: silently storing an unknown mode would
    // either be rejected by the column CHECK (a 500 on a bad request) or
    // default to `base` behind the caller's back, so the owner would believe
    // they had changed client compatibility and not have.
    throw new BadRequestError(`hrefPrefixMode must be one of: ${DAV_HREF_PREFIX_MODES.join(', ')}`);
  }
  return {
    description: (input.description ?? null),
    isPrivate: input.isPrivate,
    hrefPrefixMode: input.hrefPrefixMode,
  };
}

function checkVolumeQuota(ownedCount: number, max: number): void {
  if (ownedCount >= max) {
    throw new BadRequestError(`Maximum ${max} volumes per user`);
  }
}

export { parseVolumePatch, checkVolumeQuota, MAX_VOLUME_DESCRIPTION_LENGTH };
export type { VolumePatch, VolumePatchInput };
