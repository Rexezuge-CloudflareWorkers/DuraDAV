import { DavCredentialDAO, DavVolumeDAO } from '@durable-dav/backend-data/dao';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { BadRequestError, ForbiddenError, NotFoundError } from '@durable-dav/backend-errors';
import { isValidUsername, isValidVolumeName } from '@durable-dav/shared/constants';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';
import { TimestampUtil, UUIDUtil } from '@durable-dav/shared/utils';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';
import { checkVolumeQuota, parseVolumePatch } from './VolumeCreatePolicy';
import type { VolumePatchInput } from './VolumeCreatePolicy';
import { isVolumeOwner } from './volumeOwnership';
import type { ViewerIdentity } from './volumeOwnership';
import { UserIdentityService } from '../identity/UserIdentityService';
import type { ResolvedAccount } from '../user/accountLookup';

interface VolumeServiceEnv {
  DB: D1Queryable;
  MAX_VOLUMES_PER_USER?: string;
}

interface VolumeServiceDeps {
  volumeDAO?: () => Promise<DavVolumeDAO>;
  credentialDAO?: () => Promise<DavCredentialDAO>;
  identity?: () => Promise<UserIdentityService>;
  config?: AppConfiguration;
}

class VolumeService {
  private readonly deps: Required<Pick<VolumeServiceDeps, 'volumeDAO' | 'credentialDAO' | 'identity' | 'config'>>;

  constructor(
    env: VolumeServiceEnv,
    deps: VolumeServiceDeps = {},
  ) {
    // One `UserIdentityService` for this instance, not one per call. Its
    // address→account memo is the point of the class — `serviceBindings` binds a
    // single shared instance per request scope for exactly this reason, and this
    // default defeated it by allocating a fresh instance on every resolution.
    // Only reached when `deps.identity` is omitted (a direct construction in a
    // test or a script); the composition root always supplies the shared one.
    const identity = new UserIdentityService(env);
    this.deps = {
      volumeDAO: () => Promise.resolve(new DavVolumeDAO(env.DB)),
      credentialDAO: () => Promise.resolve(new DavCredentialDAO(env.DB)),
      identity: () => Promise.resolve(identity),
      config: AppConfiguration.fromEnv(env),
      ...deps,
    };
  }

  public static normalizeOwner(owner: string): string {
    return owner.trim();
  }

  public static normalizeName(name: string): string {
    return name.trim();
  }

  private static assertValidOwner(owner: string): void {
    // The owner *is* a username, so it must satisfy the username rule. The
    // previous owner-only regex allowed a trailing hyphen, which no username can
    // have — that admitted bucket owners that could never resolve against
    // `/users/:username`.
    if (!isValidUsername(owner)) throw new BadRequestError('Invalid owner name');
  }

  private static assertValidName(name: string): void {
    if (!isValidVolumeName(name)) throw new BadRequestError('Invalid volume name');
  }

  /**
   * Buckets owned by an account, for the quota check.
   *
   * Keyed on the stable account id, not the address: after migration 0004 a user
   * who changed their address still owns the same buckets, and an email-keyed
   * count would read as zero and let them exceed the limit.
   */
  private async countOwnedVolumes(account: ResolvedAccount): Promise<number> {
    const dao = await this.deps.volumeDAO();
    // Prefer COUNT(*) over listing rows (why: listing 1000 rows to count
    // wastes D1 reads and truncates above the limit). Fall back to list
    // length for fake-DB doubles without COUNT support.
    try {
      return await dao.countByOwnerUserId(account.id);
    } catch {
      const owned = await dao.listByOwnerUserId(account.id, 1000).catch(() => []);
      return owned.length;
    }
  }

  public async getVolume(owner: string, name: string): Promise<DavVolumeRow | null> {
    const dao = await this.deps.volumeDAO();
    // No `.catch(() => null)`: that made a D1 outage indistinguishable from a
    // missing bucket, so `davAuthForVolume`'s `DatabaseError -> 503` branch was
    // unreachable and clients cached a 404 for a bucket that still existed.
    return dao.getByOwnerName(owner, name);
  }

  public async requireVolume(owner: string, name: string): Promise<DavVolumeRow> {
    const volume = await this.getVolume(owner, name);
    if (!volume) throw new NotFoundError('Volume not found');
    return volume;
  }

  /**
   * The caller's account.
   *
   * Fails CLOSED. This used to return `null` on any error and the caller skipped
   * the ownership check when it was null — so a D1 blip, or a `users` row whose
   * username bootstrap had not completed yet, let an authenticated caller create
   * buckets in *any* user's namespace. A missing account is now an error, not a
   * bypass.
   *
   * Still fail-closed, but the two failures are kept apart. `null` means "no
   * account" and is a 404. A `DatabaseError` is an outage and must not be folded
   * into that same 404, which told the caller to sign in again for a transient
   * D1 failure. `resolveAccount` already degrades only on
   * `isMissingSchemaError` and rethrows everything else, so letting it propagate
   * reaches `toErrorResponse`, which answers 503 — and an exception here still
   * creates no bucket.
   */
  public async requireCallerAccount(email: string): Promise<ResolvedAccount> {
    const account = await this.deps.identity().then((identity) => identity.resolveAccount(email));
    if (!account) throw new NotFoundError('No account is provisioned for this address; sign in again to provision one');
    return account;
  }

  /**
   * The caller's own handle, which is the URL namespace every user-owned bucket
   * lives in. Fails closed for the same reason as `requireCallerAccount`.
   */
  private static requireCallerUsername(account: ResolvedAccount): string {
    const username = account.username;
    if (typeof username !== 'string' || username.length === 0) {
      throw new NotFoundError('No username is provisioned for this account; set one via PATCH /user/me/username');
    }
    return username.toLowerCase();
  }

  public async createVolume(input: {
    owner: string;
    name: string;
    // `unknown`, not `string | null | boolean`: these come straight off a parsed
    // JSON body and `validateVolumePatch` is the runtime check that they are
    // what they claim to be. Typing them narrowly here would make the guard
    // unreachable from the compiler's point of view.
    description?: unknown;
    isPrivate?: unknown;
    hrefPrefixMode?: DavHrefPrefixMode;
    creatorEmail: string;
  }): Promise<DavVolumeRow> {
    // Same validation as the PATCH path, and on *all three* fields rather than
    // just the mode. Passing only `hrefPrefixMode` left `isPrivate` and
    // `description` unvalidated on create: a body carrying `isPrivate: "false"`
    // stored the string, and `Number("false")` is `NaN`, so the auth layer read
    // the bucket as public and granted anonymous reads on a bucket the caller
    // had asked to make private. The 500-char description cap was the same
    // story — enforced on PATCH, absent on create.
    const patch = parseVolumePatch({ description: input.description, isPrivate: input.isPrivate, hrefPrefixMode: input.hrefPrefixMode });
    const owner = VolumeService.normalizeOwner(input.owner);
    VolumeService.assertValidOwner(owner);
    const name = VolumeService.normalizeName(input.name);
    VolumeService.assertValidName(name);
    // User-only buckets: no org volumes. The owner must be the caller's own
    // username (case-insensitive); there is no grandfathering path, because a
    // silent fallback is indistinguishable from a transient D1 failure and
    // read as "allow".
    const account = await this.requireCallerAccount(input.creatorEmail);
    const callerUsername = VolumeService.requireCallerUsername(account);
    if (owner.toLowerCase() !== callerUsername) {
      throw new ForbiddenError('Only the bucket owner can create buckets for this user');
    }
    const dao = await this.deps.volumeDAO();
    const ownedCount = await this.countOwnedVolumes(account);
    // Fail-open on outage: quota is soft, auth stays fail-closed.
    checkVolumeQuota(ownedCount, this.deps.config.getMaxVolumesPerUser());
    const existing = await dao.getByOwnerName(owner, name).catch(() => null);
    if (existing) throw new BadRequestError('Volume already exists');
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    await dao.create({
      id,
      // `owner_email` records the account's frozen anchor, once, at create time.
      // It is never updated again — it is the `users(email)` foreign key target
      // this column resolves against, so rewriting it would cascade the row
      // away. `owner_userId` is what ownership is actually decided on.
      ownerEmail: account.anchorEmail,
      ownerUserId: account.id,
      owner,
      name,
      // Validated above, so these carry the narrowed types. `?? true` is the
      // private-by-default rule: an absent flag means private, never public.
      description: patch.description ?? null,
      isPrivate: patch.isPrivate ?? true,
      hrefPrefixMode: input.hrefPrefixMode,
      now,
    });
    const created = await dao.getById(id);
    if (!created) throw new NotFoundError('Volume not found after create');
    return created;
  }

  /**
   * `patch` is the *unvalidated* body shape. Narrowing happens here, not at the
   * route, so create and PATCH cannot disagree about the rules.
   */
  public async updateVolume(owner: string, name: string, viewer: ViewerIdentity, rawPatch: VolumePatchInput): Promise<DavVolumeRow> {
    // Checked before the ownership guard so a malformed body is a 400 for the
    // owner and a 400 for a stranger alike — the guard's answer must not depend
    // on whether the body happened to be well-formed.
    const patch = parseVolumePatch(rawPatch);
    const volume = await this.requireVolume(owner, name);
    if (!isVolumeOwner(viewer, volume)) {
      throw new ForbiddenError('Only the bucket owner can update this bucket');
    }
    // "Nothing to update" is about *presence*, not truthiness: an explicit
    // `description: null` clears the field and must count.
    if (rawPatch.description === undefined && rawPatch.isPrivate === undefined && rawPatch.hrefPrefixMode === undefined) {
      throw new BadRequestError('Nothing to update');
    }
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const dao = await this.deps.volumeDAO();
    await dao.update(volume.id, {
      description: patch.description,
      isPrivate: patch.isPrivate,
      hrefPrefixMode: patch.hrefPrefixMode,
      now,
    });
    const updated = await dao.getById(volume.id);
    if (!updated) throw new NotFoundError('Volume not found after update');
    return updated;
  }

  public async deleteVolume(owner: string, name: string): Promise<void> {
    const volume = await this.requireVolume(owner, name);
    // Best-effort credential cleanup. FK cascades cover D1, but explicit
    // deletes keep fake-DB tests honest.
    const credentialDAO = await this.deps.credentialDAO();
    await credentialDAO.deleteByVolume(volume.id).catch(() => undefined);
    const dao = await this.deps.volumeDAO();
    await dao.deleteById(volume.id);
  }
}

export { VolumeService };
export type { VolumeServiceDeps, VolumeServiceEnv };
