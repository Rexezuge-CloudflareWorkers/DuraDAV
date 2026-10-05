import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export type NamespaceKind = 'user';

export interface NamespaceRow {
  username_ci: string;
  kind: NamespaceKind;
  /**
   * The claiming account's frozen anchor address. Kept as a denormalized copy;
   * ownership checks read `user_id` (migration 0004).
   */
  user_email: string | null;
  /**
  Stable account key. Absent on a pre-0004 database.
  */
  user_id?: string | null;
  created_at: number;
}

class NamespaceDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async get(usernameCi: string): Promise<NamespaceRow | null> {
    return this.firstWithRetry(
      () => this.database.prepare('SELECT * FROM namespaces WHERE username_ci = ? LIMIT 1').bind(usernameCi).first<NamespaceRow>(),
      'get namespace by username',
    );
  }

  public async isTaken(usernameCi: string): Promise<boolean> {
    const row = await this.get(usernameCi);
    return row !== null;
  }

  public async claim(input: { usernameCi: string; kind: NamespaceKind; userEmail?: string | null; userId?: string | null; now: number }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('INSERT INTO namespaces (username_ci, kind, user_email, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(input.usernameCi, input.kind, input.userEmail ?? null, input.userId ?? null, input.now)
          .run(),
      'claim namespace',
    );
  }

  public async claimIgnore(input: { usernameCi: string; kind: NamespaceKind; userEmail?: string | null; userId?: string | null; now: number }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('INSERT OR IGNORE INTO namespaces (username_ci, kind, user_email, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(input.usernameCi, input.kind, input.userEmail ?? null, input.userId ?? null, input.now)
          .run(),
      'claim namespace ignore',
    );
  }

  public async release(usernameCi: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM namespaces WHERE username_ci = ?').bind(usernameCi).run(),
      'release namespace',
    );
  }
}

export { NamespaceDAO };
