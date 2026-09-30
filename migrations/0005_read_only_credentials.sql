-- Migration 0005: Per-credential read-only flag.
--
-- A bucket credential is the *only* identity the WebDAV plane has: there is no
-- owner escape hatch in a `Basic` header, so without this a credential handed
-- to a backup agent or a read-only mount is exactly as powerful as the one in
-- the owner's own client. `read_only = 1` restricts that credential to
-- GET/HEAD/OPTIONS/PROPFIND; every content-changing method is refused with 403
-- by the front door before the request ever reaches the Durable Object.
--
-- Additive with a constant default, so `0003`'s add-column form applies and no
-- table rebuild is needed. `DEFAULT 0` is the whole safety story: every
-- credential that exists today must keep full read/write access, or applying
-- this migration would silently lock existing users out of their own buckets.

ALTER TABLE dav_credentials ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0
  CHECK(read_only IN (0, 1));
