# Durable-DAV — Background Worker

Scope: `apps/background/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — re-exports `DavVolumeWorker`, `CronTasksWorker` (also re-exported by `apps/api/src/index.ts` for DO bindings).
- `DavVolumeWorker` (`src/DavVolumeWorker.ts`) — Facade over the WebDAV volume (one per bucket, `DAV_VOLUME.getByName(normalizeVolumeKey)`). Owns exactly three things: the error boundary, method dispatch, and the wiring from `dav/methods/*` to `DavRepository`/`DavLockGuard`/`DavConditionalGuard`. Everything else is a collaborator. Files at `/` over `createDofsFs` + metadata in DO SQLite (`dav_nodes/dav_props/dav_locks` via `ensureDavSchema`). No `blockConcurrencyWhile` nesting. Bucket deletion also clears bucket credentials in D1 (best-effort, FK cascades as backstop).
  - `setDofsDeviceSize` runs **once per isolate**, not per request, and a failure is logged rather than swallowed: `dofs.setDeviceSize` has no "already set" error, so any other failure silently left the per-volume quota unenforced, forever.
  - `COPY`/`MOVE` share one `deleteDestination` closure, so `COPY` inherits DELETE's descendant-lock scan instead of reimplementing DELETE minus it.
- `src/dav/` — `DavContext.ts` (pure `fsPathOf`/`hrefOf`/`resolveInnerPath` (`string | null`)/`stripBase` + `..` traversal rejection, `MAX_PATH_DEPTH`, and `DavBases { pathBase, hrefBase }` + `resolveDavBases` for the per-bucket href prefix mode) · `Base64.ts` (allocation-light 3-byte-to-4-char codec, no spread/argument-limit) · `RangeParser.ts` (pure `parseRangeHeader`) · `DavRepository.ts` (dofs + SQL Repository: `statInner`/`readMeta`/`nodeInfo`/`listChildren|Recursive`/`upsertFile|CollectionNode`/`copyMeta`/`delete|renameCascade`) · `DavLockGuard.ts` (lock-precondition Policy; single indexed `IN` query, **fails closed** on SQL error, 256-depth cap) · `DavConditionalGuard.ts` (RFC 7232 `If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since`) · `VolumeTransfer.ts` (the username-rename copy RPCs — not reachable from any `DAV:` method) · `methods/ReadMethods|WriteMethods|PropMethods|CopyMoveMethods|LockMethods.ts` (one Command per RFC 4918 family; `PUT` reads `MAX_FILE_BYTES` via injected `AppConfiguration` and caps the body through `readCappedBody` **before** buffering it).
- **`DavBases` is load-bearing.** `pathBase` (from `X-Dav-Base`, always the real `/owner/volume`) is addressing and feeds `resolveInnerPath`/`stripBase`; `hrefBase` (from `X-Dav-Href-Prefix-Mode`, `''` in root mode) is presentation and feeds only the href builders. Never collapse them back into one `base`: a `root`-mode bucket must still resolve its own request URL against the real base, or the whole bucket reads as empty rather than merely mis-anchored. `renderCollectionHtml` uses `pathBase` deliberately — its `<a href>` is browser-resolved, which §8.3 does not govern.
- `DavVolumeWorker` method map (RFC 4918 Class 1+2, ported from `r2-webdav`):
  - `OPTIONS` → `Allow` + `DAV: 1, 2`.
  - `GET`/`HEAD` → file bytes (Range via `dofs.read(offset/length)`, streams via `readFile`) or collection HTML browser; `404` missing, `206` partial.
  - `PUT` → `409` missing parent, `405` on collection, `413` over `MAX_FILE_BYTES`, `201/204`; stores `content-type` + `etag` in `dav_nodes`.
  - `DELETE` → recursive (`rmdir` + SQL cascade), `423` on locked descendants, `403` on volume root.
  - `MKCOL` → `415` with body, `405` exists, `409` missing parent.
  - `PROPFIND` → `207` multistatus (`allprop/propname/prop`, `Depth 0/1/infinity`).
  - `PROPPATCH` → atomic dead-prop upserts in `dav_props` (`403` on protected live props, `424` on partial).
  - `COPY`/`MOVE` → `Destination` same-volume check, `Overwrite`, `400` self/descendant, locks not copied but preserved on move.
  - `LOCK`/`UNLOCK` → exclusive/shared, `Depth`, `Timeout`, empty-body refresh, `423` conflicts, lock-null resources removed on unlock.
  - `OPTIONS` is answered **after** path validation but is a capability probe, not a content access.
- `CronTasksWorker` (`src/CronTasksWorker.ts`) — `POST /run` only (else `404`); single-flight (`202 Already running`); awaits `runScheduledTasks`. Triggered by cron `*/10 * * * *`.
- `src/scheduled/TaskRegistry.ts` — `CRON_TASK_FACTORIES` with only `ExpiredCredentialPruningTask` (bucket-credential hygiene); `runScheduledTasks` runs phase 1 then phase 2.
- Composition: DO reads `AppConfiguration.fromEnv(env)` for `DO_DEVICE_BYTES`; no per-request DI container inside the DO (front resolves D1/auth before forwarding).
