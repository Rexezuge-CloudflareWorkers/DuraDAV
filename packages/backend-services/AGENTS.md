# Durable-DAV — Backend Services

Scope: `packages/backend-services/**`. Parent index: `../../AGENTS.md`. Layer 3 (may use layers 0–2 only, never apps).

- Domain map:
  - `src/auth/AccessAuthService.ts` — `/user/*` identity: `DEMO_MODE` → `DEV_AUTH_EMAIL` → JWT (`cf-access-jwt-assertion` vs `TEAM_DOMAIN`/`POLICY_AUD`) → `ctx.access.getIdentity()` fallback. Never trust `Cf-Access-Authenticated-User-Email`.
  - `src/dav/VolumeCredentialService.ts` — bucket credentials (CalDAV-style): `sha256(password)`, `MAX_CREDENTIALS_PER_VOLUME` (default 10), `DEFAULT/MAX_CREDENTIAL_EXPIRY_DAYS` (365/365); `createCredential(volumeId, volumeName, name, expiresInDays)` generates `volume-adjective-animal-digits` username + `ddav_` password with 5x unique retry; `listCredentials/deleteCredential` scoped by volume id.
  - `src/dav/VolumeService.ts` — owner-only bucket CRUD by `(owner, name)` (case-insensitive): owner must match caller username, private-by-default (`isPrivate ?? true`), `updateVolume` (description + visibility + `hrefPrefixMode`, owner-only, `validateVolumePatch` — the single owner of the href-mode enum rule, so a bad value is a 400 on both create and PATCH), limits via injected `AppConfiguration` (`getMaxVolumesPerUser`, default 100, pure `VolumeCreatePolicy.checkVolumeQuota`); delete cascades bucket credentials.
  - `src/dav/DavPermissionService.ts` — `getRole(viewerEmail|null, volume)` → `admin|read|null`: owner implicit admin, public anon read, private hidden. No collaborators, no orgs.
  - `src/user/UserService.ts` — `upsertUser` (lowercased email, idempotent; bootstraps globally-unique `username` + `namespaces` claim) + `getProfileByEmail/getByUsername/renameUsername` (validates `USERNAME_RE`, claim-first rename with self-reclaim, old names stay reserved).
- `src/composition/` — `Tokens` registry + `createRequestScope(env)` (`requestScope.ts` orchestrator; DAO tables in `daoBindings.ts`, service wiring in `serviceBindings.ts` + `serviceBindings/coreServices.ts`, shared env/factory in `serviceFactory.ts`): per-request `Container`, table-driven lazy+memoized DAO factories, lazy `AppConfig`. Handlers resolve `scope.get(Tokens.X)`.
- Constructor injection: every service takes `(env, deps?)` with `() => Promise<DAO>` factories defaulting to real DAOs — tests override with fakes (see `test/composition.test.ts`), no module mocks needed.
- Errors via `@durable-dav/backend-errors` (`Bad/Unauthorized/Forbidden/NotFoundError`); time/ids via `@durable-dav/shared/utils` (`TimestampUtil`, `UUIDUtil`, `CryptoUtil`, `DavCredentialUtil`).
