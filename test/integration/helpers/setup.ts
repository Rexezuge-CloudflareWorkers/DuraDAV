import { applyMigrations } from './migrations';

/**
 * Shared setup for Durable-DAV integration tests (real D1 via `SELF.fetch`).
 * Auth is `DEV_AUTH_EMAIL`-based, so `/user/*` needs no credentials.
 * WebDAV (`/:owner/:volume/*`) uses bucket-level Basic credentials.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

export async function ensureAesSecret(_env: TestEnv): Promise<void> {
  // No Secrets Store binding: credential hashing is sha256 (no encryption).
}

/**
 * Seed a user in the post-0004 shape.
 *
 * Writes all three identity pieces, not just the anchor: `users.id` and
 * `current_email` (the stable account key and the mutable sign-in address), the
 * `user_emails` registry row that login resolution actually goes through, and
 * the `user_id` on the namespace claim. A seed that skipped these would produce
 * a state the migration never creates, and the tests that depend on id-keyed
 * ownership would pass for the wrong reason.
 */
export async function ensureUser(db: D1Database, email: string, username?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const normalizedEmail = email.toLowerCase();
  const handle = (username ?? normalizedEmail.split('@', 1)[0]).trim() || 'user';
  const handleCi = handle.toLowerCase();
  const id = `usr_${crypto.randomUUID().replaceAll('-', '')}`;
  await db
    .prepare(
      `INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET current_email = COALESCE(users.current_email, excluded.current_email)`,
    )
    .bind(normalizedEmail, now, id, normalizedEmail)
    .run();
  // Read the id back: on a conflict the row kept its original, and the registry
  // must point at *that* account.
  const row = await db.prepare('SELECT id, current_email FROM users WHERE email = ?').bind(normalizedEmail).first<{ id: string; current_email: string }>();
  const userId = row?.id ?? id;
  await db
    .prepare('UPDATE users SET username = COALESCE(username, ?), updated_at = COALESCE(updated_at, ?) WHERE id = ?')
    .bind(handle, now, userId)
    .run();
  await db
    .prepare(
      `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(normalizedEmail, userId, now)
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO namespaces (username_ci, kind, user_email, user_id, created_at) VALUES (?, 'user', ?, ?, ?)`,
    )
    .bind(handleCi, normalizedEmail, userId, now)
    .run();
  return handle;
}

export async function setupIntegrationTest(env: TestEnv, userEmail?: string): Promise<void> {
  await applyMigrations(env.DB);
  await ensureAesSecret(env);
  if (userEmail) {
    await ensureUser(env.DB, userEmail);
  }
}

export async function seedVolume(
  db: D1Database,
  input: {
    ownerEmail: string;
    owner: string;
    name: string;
    isPrivate?: boolean;
    description?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ownerUsername = await ensureUser(db, input.ownerEmail, input.owner);
  // The owner account key: ownership is decided on this, not on the address.
  const owner = await db.prepare('SELECT id FROM users WHERE email = ?').bind(input.ownerEmail.toLowerCase()).first<{ id: string }>();
  await db
    .prepare(
      `INSERT OR IGNORE INTO dav_volumes (id, owner_email, owner_user_id, owner, name, description, is_private, created_at, updated_at, owner_ci, name_ci) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.ownerEmail.toLowerCase(),
      owner?.id ?? null,
      ownerUsername,
      input.name,
      input.description ?? null,
      input.isPrivate === false ? 0 : 1,
      now,
      now,
      ownerUsername.toLowerCase(),
      input.name.toLowerCase(),
    )
    .run();
  return id;
}

// Back-compat alias for older helpers.
export const seedRepo = seedVolume;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function mintCredentialForVolume(
  db: D1Database,
  volumeId: string,
  input: { name?: string; username?: string; expiresInDays?: number } = {},
): Promise<{ credentialId: string; username: string; password: string }> {
  const credentialId = crypto.randomUUID();
  const username = input.username ?? `test-credential-${credentialId.slice(0, 8)}`;
  const raw = `ddav_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const passwordHash = await sha256Hex(raw);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (input.expiresInDays ?? 90) * 86_400;
  await db
    .prepare(
      `INSERT INTO dav_credentials (credential_id, volume_id, username, password_hash, name, password_prefix, password_last_four, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(credentialId, volumeId, username, passwordHash, input.name ?? 'test-credential', raw.slice(0, 10), raw.slice(-4), now, expiresAt)
    .run();
  return { credentialId, username, password: raw };
}

export function basicAuthHeader(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}
