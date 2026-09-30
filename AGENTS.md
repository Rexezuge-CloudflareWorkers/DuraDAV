# AGENTS.md

Durable-DAV: Cloudflare Workers WebDAV server (`@durable-dav/monorepo`, `pnpm@11.2.2`).

- **WebDAV core**: `packages/webdav` (pure RFC 4918 Class 1+2: path/XML/prop/lock helpers, zero runtime deps except `@xmldom/xmldom`) + `packages/dav-store` (`dofs` `Fs` factory via `createDofsFs` + SQLite metadata `dav_nodes/dav_props/dav_locks`).
- **Storage**: `apps/background` `DavVolumeWorker` facade (one per bucket `DAV_VOLUME.getByName(owner/volume-lowercase)`, 5GB device applied once per isolate, files at `/` in `dofs`, dead props/locks in DO SQLite; lifecycle `deleteVolume`, username-rename transfer in `dav/VolumeTransfer.ts`) + `CronTasksWorker` (`*/10 * * * *`, credential prune only) + `CredentialVerifierDO` (`DAV_AUTH`, password-verification offload; internal-only, see Auth); D1 `migrations/0001_init.sql` baseline + `0002_bucket_credentials.sql` (`dav_credentials`, private-by-default rebuild, drops legacy token/collaborator tables) + `0003_href_prefix_mode.sql` (`dav_volumes.href_prefix_mode`) + `0004_user_identity.sql` (account key beside the email; see Identity below) + `0005_read_only_credentials.sql` (`dav_credentials.read_only`, see Read-only credentials below).
- **Identity**: the email is **not** the account. `users.id` (opaque `usr_<hex>`, unique index) is the stable key; `users.current_email` is the mutable sign-in address; `users.email` is a **frozen anchor** — immutable, still the `dav_volumes.owner_email` FK target, and what every legacy `*_email` value holds. `user_emails` is the address registry (`is_verified=1` may authenticate; a changed-from address stays at `0` so pre-change rows stay attributable and the address is released for re-registration). Ownership, quota, and permission ride on `dav_volumes.owner_user_id` / `namespaces.user_id`, with the anchor string as the pre-0004 fallback (`isVolumeOwner`). The anchor design is forced: D1 honours neither `PRAGMA foreign_keys = off` nor `legacy_alter_table`, and `defer_foreign_keys` does not suppress `ON DELETE CASCADE`, so the existing reference cannot be repointed without losing rows — 0004 is purely additive. `username` is untouched and remains the URL handle with its own DO-transfer rename. Changing an address is `scripts/change-email.ts`; `UserIdentityService.setPrimaryEmail` has **no route** (Access is the only authenticator, so self-service needs a proof-of-control step first).
- **Href prefix mode**: per-bucket `dav_volumes.href_prefix_mode` (`base` | `root`, default `base`). `base` is RFC 4918 §8.3 — hrefs carry `/owner/volume`; `root` anchors them at `/` for clients that 404 otherwise. **Presentational only.** Two separate headers keep it out of addressing: `X-Dav-Base` (always the real base) drives `resolveInnerPath`/`stripBase`, `X-Dav-Href-Prefix-Mode` drives href emission; the DO sees both as `DavBases { pathBase, hrefBase }` and defaults to `base` on an absent/unknown value. The front door canonicalises `Destination` (`apps/api`'s `davDestination.ts`) so the DO only ever sees the base-prefixed form — in root mode a client echoes back the hrefs it was given, and the DO could not tell `/etc` (a legal root file) from a `%2e%2e` escape. The HTML collection listing always uses `pathBase`; it is an `<a href>`, not a `DAV:href`.
- **Auth**: `/user/*` Cloudflare Access (`AccessAuthService`: DEMO→DEV→JWT→`ctx.access` fallback; never trust `Cf-Access-Authenticated-User-Email`); email login resolved to an account via `UserIdentityService` (one memoized instance per request scope, shared through `Tokens.UserIdentityService` — **not** `new` per consumer), plus a globally-unique mutable username (single `user` namespace; buckets are owner-only, no orgs, no collaborators); WebDAV bucket Basic (`username:password`, PBKDF2-SHA256 with per-hash salt + constant-time compare, bound to volume id, expiry enforced, `volume-adjective-animal-digits` usernames, `MAX_CREDENTIALS_PER_VOLUME=10`, private-by-default, public opt-in anon reads). Credential lookup is by `username` only — a salted hash cannot be searched on; the legacy unsalted-SHA256 format still verifies and is rehashed on first successful use. The `Basic` scheme token is matched **case-insensitively** (RFC 9110 §11.1); only the scheme is folded, never the decoded credentials. The `DEMO_MODE`/`DEV_AUTH_EMAIL` bypasses are **not** in `wrangler.template.jsonc` and `AppConfiguration.validate()` warns if one is set with `ENVIRONMENT=production`.
- **Password verification is tiered, because one derivation can exceed the whole CPU budget.** A Worker on the Workers **Free** plan has **10 ms of CPU per invocation**; one PBKDF2-SHA256 derivation at the shipped 100 000 iterations costs roughly 10-20 ms. Verifying on every request therefore overran the budget on *every* Basic-auth request, Cloudflare killed the invocation, and the client got an HTTP **503** with `outcome: "exceededCpu"` — a status no code here emits, so it read as a mysterious platform fault. It surfaced on reads (`GET` with `Range`, `PROPFIND Depth: 1`) because reads are all a **read-only credential** can attempt, which made it look like a read-only-credentials bug when it was a CPU bug for *every* credential. Three tiers, cheapest first, in `apps/api/src/middleware/credentialVerifier.ts`: **(1)** per-isolate TTL/LRU memo (`credentialMemo.ts`, no hop — the steady state for a client already on this isolate), **(2)** `CredentialVerifierDO` (one hop; a DO gets 30 s of CPU *regardless of plan*, Cloudflare's own documented remedy), **(3)** local derivation (fallback only: no binding, or a failed hop). Only the **derivation** is ever reused — the volume row and credential row are still read from D1 per request, so revocation, expiry, `read_only` flips, volume rebinding, and password rotation all take effect **immediately**. The memo key is `username` + a fingerprint of the presented password (`DavCredentialUtil.fingerprint`, one unsalted SHA-256, a memo key and **not** a credential): keying on `username` alone would accept any password for a recently-used username. **Failures are never cached**, so a wrong password always costs a real derivation and the brute-force cost is unchanged. The verifier returns the upgraded hash alongside the verdict, which removes a *second* full derivation from the legacy-digest rehash (`DavAuth`) — the heaviest CPU path in the flow. Sharding is mandatory, not an optimization: a DO serializes per object, so one verifier would make all auth queue behind it (`credentialShardOf` in `shared`, so caller and verifier cannot disagree).
- **Read-only credentials**: `dav_credentials.read_only` (migration 0005) restricts one bucket credential to `GET/HEAD/OPTIONS/PROPFIND`; every other method is refused **at the front door** with `403` + an RFC 4918 §16 `DAV:error` body (`davErrorResponse` in `packages/webdav`, code `cannot-modify-protected-property`) and deliberately **no** `WWW-Authenticate` — a 401 or a 403 carrying that header sends a native client into a re-prompt loop. The DO has no auth of its own, so this check in `DavAuth` (guarded on `needWrite`, before the rehash and `last_used_at` writes) is the complete enforcement point. There is **no owner escape hatch**: `Basic` auth carries no owner identity, so a read-only credential is read-only for everyone holding it, including the bucket owner. It does not restrict the browser plane, which authenticates through Access as the owner. Set at creation (`readOnly`) and flippable afterwards (`PATCH .../credentials/:id`); a non-boolean is a 400, never a silent `false`; `DEFAULT 0` on the column is what keeps pre-0005 credentials writable.
- **API**: `apps/api` Hono+Chanfana `DurableDavWorker` (`/:owner/:volume/*` WebDAV via DO `fetch` forward + `/user/volumes` CRUD (quota-enforced, owner-only, private-by-default, `PATCH` visibility + `hrefPrefixMode`) + per-bucket `/user/volumes/:owner/:volume/credentials` + `/user/me` + `/users/:username` + `/health`, `/docs`); permissions owner-only via `DavPermissionService.getRole(viewer, volume)` where `viewer` is `{ userId, email }`; `apps/api/src/index.ts` re-exports DOs for bindings. `AuthenticatedUserEmailAddress` is the *sign-in* address (display, rate-limit key); `AuthenticatedUserId` is the account key (authorization) — `/user/*` middleware sets both from one resolution. `X-Dav-User` forwards the owner's resolved current address, never the frozen anchor.
- **Paged browse**: opt-in `?page=`/`?limit=` on the browser plane only (`davPageParams.ts` → `X-Dav-Page`/`X-Dav-Page-Limit`), answered by the DO as `X-Dav-Page-Count`/`X-Dav-Page`/`X-Dav-Page-Limit` on the 207 (`PropfindPaging.ts`). **RFC 4918 §9.1 has no paging concept**, so a `Depth: 1` PROPFIND must return every member — which is why `applyDavForwardHeaders` *deletes* both `X-Dav-Page*` headers and only re-adds them when the browser plane explicitly opts in. A native DAV client hand-setting them used to survive on the WebDAV plane, truncate the multistatus, and poison `DavReadCache` (whose key carries no page term), so a truncated body was served to every later unpaged PROPFIND for the entry's TTL. The DO clamps page size to `MAX_PAGE_SIZE=250` and the page to the last real one (an out-of-range page rendering empty reads as "this folder is empty", which is *wrong*, not merely unhelpful). Query params rather than headers specifically so Durable-DAV-Router forwards them with no allowlist change. The page query is a direct indexed read of `dofs_files(parent, name)` via `listDirPage` in `patches/dofs@0.1.0.patch`; the trailing binary `name` in its `ORDER BY` is load-bearing, because `NOCASE` alone is not a total order and a non-deterministic tiebreak puts an entry on two pages or none.
- **Web**: `apps/web` Vite SPA (build embeds `dist/index.html` → `apps/api/src/generated/spa-shell.ts`); `GET /`, `/new`, `/settings`, `/:username` serve the shell, `GET /:owner/:volume` content-negotiates (`Accept: text/html` → SPA `VolumeView` with `?path=` subpaths + `?tab=settings` per-bucket General/Credentials/Danger-Zone, else DO forward); WebDAV clients use raw methods.
- **Composition**: single scope per request via `scopeMiddleware` (`BaseRoute.getScope(c).get(Tokens.X)`; `createRequestScope(env)` is the composition root, table-driven DAO wiring + single `DavPermissionService` binding); `Container` + `createServiceContext` + `AppConfiguration` in `@durable-dav/backend-runtime/di+config` are the DI foundation. `VolumeScopedRoute` (`apps/api`) is the template method for every volume-scoped handler: one ownership guard, 404-vs-403 as a constructor argument, one error mapping.
- **D1 predicates**: lowercase the _parameter_, never the column — `lower(col)` makes that column's index unusable. Credential lookup never filters on `password_hash`.
- **i18n**: backend strings in `packages/shared/src/i18n` (wired via `BaseRoute.toErrorResponse`).

## Commands

```bash
pnpm install --ignore-scripts
pnpm -r typecheck        # 11 projects, including `test/`
pnpm run lint            # NODE_OPTIONS=--max-old-space-size=8192 is required; bare `eslint` OOMs
pnpm run test
pnpm run test:coverage   # enforced floor 35/31/41/36 — raise, never lower to pass
pnpm run test:integration
pnpm run validate:locales
pnpm run checks          # typecheck + lint + god-files
pnpm run typegen
pnpm exec wrangler dev --config ./wrangler.jsonc

# ops: change a user's sign-in address (see migrations/0004_user_identity.sql)
pnpm exec tsx scripts/change-email.ts --db durable-dav-db --account <email|username> --to <new-email> [--dry-run] [--remote]
```

No committed `wrangler.jsonc` secrets. God-file guard 300/400 warn-only; currently **zero** files over 300.
`test/` is a workspace project, so `pnpm -r typecheck` and `pnpm run lint` both reach it. Integration tests collect no coverage: the v8 provider needs `node:inspector/promises`, which does not exist inside workerd.
`pnpm run build` is the **only** build (just `apps/web`); it must be re-run after any `apps/web` change and before `wrangler deploy`. The API worker serves the last local build via the gitignored `apps/api/src/generated/spa-shell.ts`, so a frontend fix is inert until the bundle is regenerated. `scripts/verify-spa-shell.mjs` runs in `checks` and rejects a missing, stubbed, or half-refreshed artifact.

## Layers

```
shared, backend-errors, webdav → 0 deps (webdav may use xmldom only)
backend-runtime → 0 only
backend-data, dav-store → 0 only (+dofs for dav-store, +webdav for dav-store meta types)
backend-services → 0-2 (not apps)
background → 0-3 + webdav/dav-store (not apps/api)
api → 0-3 + background + webdav (NOT dav-store directly; NOT backend-data/dao except type-only)
```

## Import Direction

```
Layer 0: shared, backend-errors, webdav   — zero @durable-dav/* deps (except xmldom)
Layer 1: backend-runtime                 → layer 0 only
Layer 2: backend-data, dav-store         → layer 0 only (+webdav types for dav-store)
Layer 3: backend-services                → layers 0–2 (not apps)
Layer 5: apps/background                 → layers 0–3 + webdav/dav-store (not apps/api)
         apps/api                        → layers 0–3 + background + webdav (NOT dav-store directly; NOT backend-data/dao except type-only)
```

Enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`: `apps/api` blocks `→ @durable-dav/dav-store` (all imports) and `→ @durable-dav/backend-data/dao` (`allowTypeImports: true`). `apps/api → apps/background` re-export is allowed (`src/index.ts` re-exports `CronTasksWorker`, `DavVolumeWorker` for bindings).

## Index

| Area                             | Guide                             |
| -------------------------------- | --------------------------------- |
| API worker, auth, routes         | `apps/api/AGENTS.md`              |
| Background worker, cron, volumes | `apps/background/AGENTS.md`       |
| WebDAV RFC 4918 notes            | `packages/webdav/README.md`       |
| D1/DAO layer                     | `packages/backend-data/AGENTS.md` |
| Bindings, wrangler, env vars, DI | `docs/agents/runtime/AGENTS.md`   |
| Tests, thresholds, mock patterns | `docs/agents/testing/AGENTS.md`   |

````

## Commit Policy

Always commit changes after completing work unless explicitly told not to.

## Git Commit Messages

Format: `<TYPE>[optional scope]: <description>`

- Type in UPPERCASE: `FIX`, `FEAT`, `DOCS`, `STYLE`, `REFACTOR`, `TEST`, `BUILD`, `CHORE`, `CI`, `PERF`.
- Scope in lowercase: `FEAT(runtime): Add Scheduled Job State`.
- Description: Title Case words — `DOCS: Latest Agents Context Reflection`.
- When committing from `main`, first create a branch: `type/description` or `type/scope/description` in kebab-case (e.g. `feat/bootstrap/bootstrap-jqanywhere-v0.1-framework`).
- Always include a Markdown body separated from the subject by a blank line.
- Breaking changes: `!` after type/scope, or `BREAKING CHANGE: <description>` footer.

```text
<TYPE>[optional scope]: <description>

[Markdown body]

[optional footers]
````
