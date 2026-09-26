-- Migration 0003: Per-bucket `DAV:href` prefix mode.
--
-- RFC 4918 §8.3 requires every `DAV:href` to be a URI reference that resolves
-- against the *request* URL, so hrefs must carry the `/owner/volume` base. That
-- is the default and stays the default: `base`.
--
-- `root` is the opt-out for clients that instead expect hrefs anchored at `/`
-- (i.e. `/dir/file.txt`). It only changes how hrefs are *emitted*; request
-- addressing, `Destination` canonicalisation, and every stored path are
-- unchanged.
--
-- `ALTER TABLE ... ADD COLUMN` (rather than another table rebuild like 0002)
-- because this adds a column with a constant default and changes no existing
-- default — SQLite allows it, and existing rows take 'base' automatically.

ALTER TABLE dav_volumes ADD COLUMN href_prefix_mode TEXT NOT NULL DEFAULT 'base'
  CHECK(href_prefix_mode IN ('base', 'root'));
