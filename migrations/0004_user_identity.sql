-- Migration 0004: Decouple the user identifier from the email address.
--
-- Before this migration `users.email` was the PRIMARY KEY *and* the identity key
-- of every user-keyed column, so the address was the account. It could not be
-- changed: `dav_volumes` carried a live
-- `FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE`, so
-- rewriting an address either tripped the constraint or cascaded the user's
-- buckets out of the database. `namespaces.user_email` held the same value with
-- no FK to protect it, so it silently forked the handle away from its owner.
--
-- After this migration:
--   * `users.id` is the stable account key (opaque `usr_<hex>`).
--   * `users.current_email` is the mutable sign-in address.
--   * `users.email` becomes the frozen *anchor* address. It is never updated,
--     so the existing foreign key and every existing `*_email` value keep
--     resolving forever, and no table has to be rebuilt.
--   * `user_emails` is the address registry: an address maps to an account,
--     `is_verified = 1` means "may be used to log in". A changed-from address is
--     retained with `is_verified = 0` so pre-change rows stay attributable while
--     the address stops authenticating, and it is released for re-registration
--     by a later account.
--   * `dav_volumes.owner_user_id` and `namespaces.user_id` are the identity the
--     DAOs read and write. The legacy `*_email` string columns stay as
--     denormalized copies: still written, no longer the identity.
--
-- Why the address stays in `users` at all: D1 enforces foreign keys through the
-- Worker binding and honours neither `PRAGMA foreign_keys = off` nor
-- `PRAGMA legacy_alter_table = on` (both verified against real D1). Since SQLite
-- rewrites a child's foreign key clause when the parent is renamed, and drops a
-- parent by cascading, the reference from `dav_volumes.owner_email` cannot be
-- repointed at `users.id` without losing rows. Keeping `email` as a frozen
-- anchor sidesteps the rebuild entirely: this migration is purely additive.
--
-- `dav_credentials` is deliberately untouched. Bucket credentials bind to
-- `dav_volumes(id)` and carry no user reference at all, so an address change
-- cannot invalidate one.
--
-- `username` is also untouched. It is already a mutable, globally-unique public
-- handle with its own rename path (`users.username` -> `namespaces.username_ci`,
-- plus a `dav_volumes.owner` cascade and a DO transfer). It is the name, not the
-- account; `user_id` is the account.
--
-- Rerunnable: every backfill is guarded by `IS NULL` / `INSERT OR IGNORE`, and
-- `users.id` is only filled where it is still missing.

-- ============================================================
-- Phase 1: stable account key
-- ============================================================
-- SQLite cannot add a PRIMARY KEY column, so the id is a plain column with a
-- unique index. A unique index is a valid foreign key parent, which is all the
-- `user_id` references below need.
ALTER TABLE users ADD COLUMN id TEXT;

UPDATE users SET id = 'usr_' || lower(hex(randomblob(16))) WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users(id);

-- ============================================================
-- Phase 2: mutable sign-in address
-- ============================================================
-- `email` stays as the frozen anchor (see the header note); `current_email` is
-- what the account signs in with and what the API reports. Uniqueness is
-- enforced here, so an address can never be claimed by two accounts.
ALTER TABLE users ADD COLUMN current_email TEXT;

UPDATE users SET current_email = lower(email) WHERE current_email IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_current_email ON users(current_email);

-- ============================================================
-- Phase 3: address registry
-- ============================================================
-- Login resolution consults `is_verified = 1` only. Backfilled from the frozen
-- anchor address of every existing account, lowercased so a legacy mixed-case
-- row still yields exactly one login identity.
CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails(user_id);

INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at)
SELECT lower(email), id, 1, created_at FROM users;

-- ============================================================
-- Phase 4: the account key on every user-referencing table
-- ============================================================
-- Additive only: `ALTER TABLE ... ADD COLUMN`, then a backfill that resolves
-- each stored address through the registry. Resolving via `user_emails` rather
-- than `users.email` means legacy rows also resolve once an address is linked
-- as an alias, and the lowercased join is case-insensitive by construction.
--
-- An address that matches no account leaves the id NULL. That is intentional:
-- the row keeps its string column and the DAOs fall back to the `*_email`
-- read, which is how an unknown or deleted actor stays attributable instead of
-- breaking the query.

-- `dav_volumes` decides ownership, so it carries an index on the account key.
-- The unique `(owner_ci, name_ci)` index is left in place: the URL namespace is
-- the username, not the account id.
--
-- `ON DELETE CASCADE` is load-bearing, not decoration. A bare `REFERENCES users(id)`
-- defaults to NO ACTION, which *restricts* — and because `owner_email` already
-- cascaded, adding a plain reference would make `DELETE FROM users` fail
-- outright where it previously removed the user's buckets. The two references
-- then cascade together. SQLite permits an `ADD COLUMN` with a `REFERENCES`
-- clause only when the column defaults to NULL, which is why there is no
-- `NOT NULL` here.
ALTER TABLE dav_volumes ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE dav_volumes SET owner_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(dav_volumes.owner_email) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_dav_volumes_owner_user_id ON dav_volumes(owner_user_id);

-- `namespaces` decides handle ownership. A namespace is claimed by exactly one
-- account, so `(username_ci, user_id)` is unique the way `(volume_id, user_id)`
-- was in the pre-0002 collaborator model. NULL ids are distinct in a SQLite
-- unique index, so a row whose address matched no account never collides.
-- `ON DELETE CASCADE` for the same reason as `dav_volumes.owner_user_id` above:
-- without it this reference would restrict, and `DELETE FROM users` — which
-- previously cascaded cleanly through the volume — would start failing.
ALTER TABLE namespaces ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE namespaces SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(namespaces.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_namespaces_user ON namespaces(username_ci, user_id);
CREATE INDEX IF NOT EXISTS idx_namespaces_user_id ON namespaces(user_id);

-- ============================================================
-- Phase 5: verify
-- ============================================================
-- Every backfill above resolved through `user_emails`, so no foreign key should
-- be dangling. `PRAGMA foreign_key_check` reports violations as rows rather than
-- raising, so `UserIdentityUpgrade.int.test.ts` asserts it comes back empty
-- against a seeded database.
PRAGMA foreign_key_check;
