import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { DavCredentialInternal, DavCredentialMetadata } from '@durable-dav/shared/model';
import { TimestampUtil, UUIDUtil } from '@durable-dav/shared/utils';

class DavCredentialDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(
    volumeId: string,
    username: string,
    passwordHash: string,
    name: string,
    passwordPrefix: string,
    passwordLastFour: string,
    expiresAt: number,
    readOnly = false,
  ): Promise<DavCredentialMetadata> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const credentialId = UUIDUtil.getRandomUUID();
    await this.withRetry(
      () =>
        this.database
          .prepare(
            `INSERT INTO dav_credentials
              (credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at, read_only)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(credentialId, volumeId, username, passwordHash, name, passwordPrefix, passwordLastFour, now, expiresAt, readOnly ? 1 : 0)
          .run(),
      'create dav credential',
    );
    const credential = await this.getById(credentialId);
    if (!credential) throw new Error('Failed to load DAV credential after create.');
    return credential;
  }

  /**
   * Load the active credential for a username, including its stored hash.
   *
   * The password is *not* part of the lookup. Passwords are salted (PBKDF2), so
   * two users with the same password have different hashes and no hash can be
   * searched on. The caller verifies the password against the returned
   * `passwordHash` with a constant-time compare. `username` is globally unique,
   * so at most one row can match.
   *
   * The hash is intentionally part of the return value — it is the input to
   * verification, and returning a metadata projection without it would force a
   * second query on the auth hot path.
   *
   * `read_only` is named here for the same reason: the auth decision that reads
   * it is made on this one query, and a projection that omitted the column would
   * coerce to `false` and quietly hand out write access.
   */
  public async getActiveByUsername(
    username: string,
  ): Promise<(DavCredentialMetadata & { volumeId: string; passwordHash: string }) | undefined> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    // `firstWithRetry`, not a bare `.first()`: this is the auth hot path, and
    // `DavAuth` maps a `DatabaseError` here to a 503 "Authentication
    // unavailable". A bare `.first()` rejects with a raw `D1_ERROR` — not a
    // `DatabaseError` — so that documented branch was unreachable and a D1 blip
    // surfaced as an opaque 500. Retrying also matches every write in this DAO,
    // which always went through `withRetry`.
    const row = await this.firstWithRetry(
      () =>
        this.database
          .prepare(
            `SELECT credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at, last_used_at, read_only
             FROM dav_credentials
             WHERE username = ? AND expires_at > ?
             LIMIT 1`,
          )
          .bind(username, now)
          .first<DavCredentialInternal>(),
      'get active dav credential by username',
    );
    if (!row) return undefined;
    const metadata = this.toMetadata(row);
    return metadata ? { ...metadata, passwordHash: row.password_hash } : undefined;
  }

  public async getById(credentialId: string): Promise<DavCredentialMetadata | undefined> {
    // `firstWithRetry` per this package's rule that no read calls `.first()`
    // bare: a raw `D1_ERROR` is not a `DatabaseError`, so every documented
    // `DatabaseError` handler above this read — the 503s in `BaseRoute` — would
    // be unreachable and a D1 blip would surface as an opaque 500. Three lines
    // below `getActiveByUsername`, which documents the rule in full.
    const row = await this.firstWithRetry(
      () =>
        this.database
          .prepare(
            `SELECT credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at, last_used_at, read_only
             FROM dav_credentials WHERE credential_id = ? LIMIT 1`,
          )
          .bind(credentialId)
          .first<DavCredentialInternal>(),
      'get dav credential by id',
    );
    return row ? this.toMetadata(row) : undefined;
  }

  public async listByVolume(volumeId: string): Promise<DavCredentialMetadata[]> {
    const rows = await this.allWithRetry<DavCredentialInternal>(
      () =>
        this.database
          .prepare(
            `SELECT credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at, last_used_at, read_only
             FROM dav_credentials WHERE volume_id = ? ORDER BY created_at DESC`,
          )
          .bind(volumeId)
          .all<DavCredentialInternal>(),
      'list dav credentials by volume',
    );
    return rows.map((row) => this.toMetadata(row));
  }

  /**
   * How many credentials a bucket already has, for `MAX_CREDENTIALS_PER_VOLUME`.
   *
   * Retried because the caller uses the answer to *reject* a creation: a D1 blip
   * that surfaced as a raw error became a 500 on an unrelated request, and one
   * that degraded to `0` would let the cap be bypassed entirely.
   */
  public async countByVolume(volumeId: string): Promise<number> {
    const row = await this.firstWithRetry(
      () =>
        this.database
          .prepare('SELECT COUNT(*) AS count FROM dav_credentials WHERE volume_id = ?')
          .bind(volumeId)
          .first<{ count: number }>(),
      'count dav credentials by volume',
    );
    return row?.count ?? 0;
  }

  /**
   * Whether a username is already claimed anywhere in D1.
   *
   * A uniqueness probe, so it is read through `firstWithRetry` like every other
   * read: the two callers (`ensureUsername`, credential creation) both treat a
   * throw as "cannot proceed" rather than as "available".
   */
  public async usernameExists(username: string): Promise<boolean> {
    const row = await this.firstWithRetry(
      () =>
        this.database
          .prepare('SELECT 1 AS found FROM dav_credentials WHERE username = ? LIMIT 1')
          .bind(username)
          .first<{ found: number }>(),
      'check dav credential username exists',
    );
    return Boolean(row?.found);
  }

  /**
   * Replace a credential's password hash.
   *
   * Used by the opportunistic legacy-digest upgrade on the auth path. `prefix`
   * and `last_four` are stored alongside the hash for display only and do not
   * change, so they are intentionally not rewritten here.
   */
  public async updatePasswordHash(credentialId: string, passwordHash: string): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE dav_credentials SET password_hash = ? WHERE credential_id = ?')
          .bind(passwordHash, credentialId)
          .run(),
      'update dav credential password hash',
    );
  }

  /**
   * Flip a credential's read-only flag.
   *
   * Scoped to the volume as well as the credential id, so a credential id
   * guessed from another bucket cannot be flipped. Nothing else about the
   * credential changes — in particular the password is untouched, so this
   * cannot be used to smuggle a new secret past the copy-once reveal.
   */
  public async updateReadOnly(credentialId: string, volumeId: string, readOnly: boolean): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE dav_credentials SET read_only = ? WHERE credential_id = ? AND volume_id = ?')
          .bind(readOnly ? 1 : 0, credentialId, volumeId)
          .run(),
      'update dav credential read-only flag',
    );
  }

  public async updateLastUsed(credentialId: string): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE dav_credentials SET last_used_at = ? WHERE credential_id = ?')
          .bind(TimestampUtil.getCurrentUnixTimestampInSeconds(), credentialId)
          .run(),
      'update dav credential last used',
    );
  }

  public async deleteForVolume(credentialId: string, volumeId: string): Promise<void> {
    await this.withRetry(
      () =>
        this.database.prepare('DELETE FROM dav_credentials WHERE credential_id = ? AND volume_id = ?').bind(credentialId, volumeId).run(),
      'delete dav credential',
    );
  }

  public async deleteByVolume(volumeId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM dav_credentials WHERE volume_id = ?').bind(volumeId).run(),
      'delete dav credentials by volume',
    );
  }

  public async pruneExpired(now: number, limit: number): Promise<number> {
    return this.deleteRowsOlderThan('dav_credentials', 'expires_at', now, limit, 'credential_id');
  }

  private toMetadata(row: DavCredentialInternal): DavCredentialMetadata {
    return {
      credentialId: row.credential_id,
      volumeId: row.volume_id,
      name: row.name,
      username: row.username,
      passwordPrefix: row.password_prefix,
      passwordLastFour: row.password_last_four,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      // A row written before migration 0005 has no `read_only` at all, and D1
      // hands the field back as `undefined`; both that and a 0 coerce to
      // `false`, which is the direction that preserves existing behaviour.
      readOnly: Number(row.read_only) === 1,
    };
  }
}

export { DavCredentialDAO };
