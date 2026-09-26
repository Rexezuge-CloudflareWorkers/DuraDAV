# Durable-DAV

WebDAV server (RFC 4918 Class 1 + Class 2) over `dofs` (Durable Object filesystem) on Cloudflare Workers.

- Multi-volume from day one: each volume lives at `/:owner/:volume/` backed by one `DavVolumeWorker` DO (`DAV_VOLUME.getByName(owner/volume)`), files in `dofs`, dead properties + locks in DO SQLite.
- Auth: Cloudflare Access for `/user/*` + per-bucket Basic credentials for WebDAV (bound to volume id, expiry enforced, `MAX_CREDENTIALS_PER_VOLUME=10`). Each user gets up to `MAX_VOLUMES_PER_USER` (100) private-by-default buckets; public buckets allow anon reads.
- Minimal browser UI: `GET /` and collection `GET` return simple HTML listings (no SPA build).
- Only needed bindings: D1 `DB`, DOs `DAV_VOLUME` + `CRON_TASKS`, cron `*/10 * * * *`.

## Quick Start

```bash
pnpm install --ignore-scripts
pnpm -r typecheck
pnpm run test
pnpm exec wrangler dev --config ./wrangler.jsonc
```

Create a volume (authenticated via Access in browser, or DEV email locally):

```bash
curl -X POST http://localhost:8787/user/volumes \
  -H 'Content-Type: application/json' \
  -d '{"owner":"test","name":"photos"}'
```

WebDAV with litmus:

```bash
litmus -k http://localhost:8787/test/photos/ basic copymove props locks
```

## Layout

- `packages/webdav/` — pure RFC 4918 helpers (paths, XML, live/dead props, locks).
- `packages/dav-store/` — `dofs` factory + DO SQLite schema (`dav_nodes/props/locks`).
- `apps/background/src/DavVolumeWorker.ts` — per-volume DO (all WebDAV methods).
- `apps/api/` — `DurableDavWorker` front (auth, volume CRUD, DO forward, CORS, browser HTML).
- `migrations/0001_init.sql` baseline + `0002_bucket_credentials.sql` (`dav_credentials`, private-by-default; bucket credentials cascade on volume delete) + `0003_href_prefix_mode.sql` (per-bucket `DAV:href` anchoring).
- `test/dav-webdav.test.ts` + `test/dav-config.test.ts` + `test/dav-do-helpers.test.ts` + `test/integration/api/DavLifecycle.int.test.ts` — unit + DO integration.
