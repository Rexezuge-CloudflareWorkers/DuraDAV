import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { DavHrefPrefixMode } from '@durable-dav/shared/constants';
import { DEFAULT_DAV_HREF_PREFIX_MODE } from '@durable-dav/shared/constants';

export interface DavVolumeRow {
  id: string;
  owner_email: string;
  owner: string;
  name: string;
  description: string | null;
  is_private: number;
  created_at: number;
  updated_at: number;
  owner_ci: string;
  name_ci: string;
  /**
   * How `DAV:href` is anchored for this bucket: `base` (RFC 4918 §8.3, the
   * href carries `/owner/volume`) or `root` (opt-out for clients that expect
   * the volume root at `/`). Absent from rows written before migration 0003;
   * coerce with `readDavHrefPrefixMode`, which defaults those to `base`.
   */
  href_prefix_mode: string;
}

class DavVolumeDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    ownerEmail: string;
    owner: string;
    name: string;
    description: string | null;
    isPrivate: boolean;
    /**
     * Omitted means the column default (`base`), so a caller that never heard
     * of the setting writes the conforming shape.
     */
    hrefPrefixMode?: DavHrefPrefixMode;
    now: number;
  }): Promise<void> {
    const ownerCi = input.owner.toLowerCase();
    const nameCi = input.name.toLowerCase();
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO dav_volumes (id, owner_email, owner, name, description, is_private, href_prefix_mode, created_at, updated_at, owner_ci, name_ci) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            input.id,
            input.ownerEmail,
            input.owner,
            input.name,
            input.description,
            input.isPrivate ? 1 : 0,
            input.hrefPrefixMode ?? DEFAULT_DAV_HREF_PREFIX_MODE,
            input.now,
            input.now,
            ownerCi,
            nameCi,
          )
          .run(),
      'create dav volume',
    );
  }

  public async getByOwnerName(owner: string, name: string): Promise<DavVolumeRow | null> {
    const result = await this.database
      .prepare('SELECT * FROM dav_volumes WHERE owner_ci = ? AND name_ci = ? LIMIT 1')
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<DavVolumeRow>();
    return result ?? null;
  }

  public async getById(id: string): Promise<DavVolumeRow | null> {
    const result = await this.database.prepare('SELECT * FROM dav_volumes WHERE id = ? LIMIT 1').bind(id).first<DavVolumeRow>();
    return result ?? null;
  }

  public async update(
    id: string,
    patch: { description?: string | null; isPrivate?: boolean; hrefPrefixMode?: DavHrefPrefixMode; now: number },
  ): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const bindings: unknown[] = [patch.now];
    if (patch.description !== undefined) {
      sets.push('description = ?');
      bindings.push(patch.description);
    }
    if (patch.isPrivate !== undefined) {
      sets.push('is_private = ?');
      bindings.push(patch.isPrivate ? 1 : 0);
    }
    if (patch.hrefPrefixMode !== undefined) {
      sets.push('href_prefix_mode = ?');
      bindings.push(patch.hrefPrefixMode);
    }
    bindings.push(id);
    await this.withRetry(
      () =>
        this.database
          .prepare(`UPDATE dav_volumes SET ${sets.join(', ')} WHERE id = ?`)
          .bind(...bindings)
          .run(),
      'update dav volume',
    );
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 1000): Promise<DavVolumeRow[]> {
    const result = await this.database
      // `owner_email` is stored lowercased (`VolumeService.createVolume`), so
      // the function call defeated `idx_dav_volumes_owner_email` on a hot path.
      // Lowercase the parameter instead to keep the index usable.
      .prepare('SELECT * FROM dav_volumes WHERE owner_email = ? ORDER BY updated_at DESC LIMIT ?')
      .bind(ownerEmail.toLowerCase(), limit)
      .all<DavVolumeRow>();
    return result.results ?? [];
  }

  public async renameOwner(oldOwnerCi: string, newOwner: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE dav_volumes SET owner = ?, owner_ci = ?, updated_at = ? WHERE owner_ci = ?')
          .bind(newOwner, newOwner.toLowerCase(), now, oldOwnerCi.toLowerCase())
          .run(),
      'rename volume owner',
    );
  }

  public async countByOwnerEmail(ownerEmail: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS cnt FROM dav_volumes WHERE owner_email = ?')
      .bind(ownerEmail.toLowerCase())
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  public async deleteById(id: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM dav_volumes WHERE id = ?').bind(id).run(), 'delete dav volume');
  }
}

export { DavVolumeDAO };
