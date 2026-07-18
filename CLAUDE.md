# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Zhixing (知行) — "a map of China with stories". Two content layers: a **culture layer** (风物卡 "feature cards": AI-generated, human-reviewed) and a **footprint layer** (user footprints, private by default, publishable via review). Product spec: docs/superpowers/specs/2026-07-06-zhixing-design.md; M2 design: docs/superpowers/specs/2026-07-07-m2-design.md; milestone implementation plans live in docs/superpowers/plans/ (checkbox-driven, task by task; finished milestones are tagged: m0 / m1-server / m1-ios). Ops runbooks: docs/content-ops.md (content ingestion & ongoing ops), docs/deploy.md (VPS deployment), docs/testflight.md (TestFlight release), docs/mac-install.md (Mac beta install guide for testers). Visual design tokens: design-system/知行/MASTER.md.

pnpm monorepo (Node >= 22; pnpm pinned to 10.34.4 — do not touch the packageManager field in package.json):

- `apps/api` — Fastify 5 API (:8787)
- `apps/admin` — Next.js 15 admin console (:3000), client-side fetch only, no server-side data access
- `apps/pipeline` — feature-card content pipeline CLI (Gemini / DeepSeek)
- `apps/ios` — SwiftUI app (Swift 6, iOS 17+, XcodeGen)
- `packages/db` — Prisma schema + `createPrisma` factory (`@zhixing/db`, exports TS source directly)

## Common commands

```sh
pnpm db:up                                          # Postgres (:5433, non-default port) + MinIO (:9000); Docker must be running
pnpm --filter @zhixing/db exec prisma migrate dev   # dev-DB migrations (also runs prisma generate)
pnpm --filter @zhixing/api dev                      # API :8787
pnpm --filter @zhixing/admin dev                    # admin console :3000

# Tests (real Postgres/MinIO, no mocks; requires pnpm db:up first)
pnpm -C packages/db push:test                       # create tables in the zhixing_test DB — required on first run and after every schema change
pnpm test                                           # all packages (forced serial; shared test DB)
pnpm -C apps/api exec vitest run                    # full api suite (run after each task, before committing)
pnpm -C apps/api exec vitest run test/trips.test.ts # single test file
scripts/ios-test.sh                                 # iOS tests (xcodegen generate + xcodebuild test on a simulator)
scripts/mac-dev.sh                                  # Mac Catalyst debug env: Postgres/MinIO + dev API + Zhixing.app (Debug-maccatalyst)
scripts/mac-dmg.sh                                  # Mac Catalyst Release build + dmg (ad-hoc signing by default; MAC_SIGN_IDENTITY upgrades to Developer ID + notarization)

# Content pipeline (set GEMINI_API_KEY or DEEPSEEK_API_KEY in .env; import/batch are idempotent)
pnpm --filter @zhixing/pipeline import-places
pnpm --filter @zhixing/pipeline import-regions
pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category ANECDOTE --count 1
pnpm --filter @zhixing/pipeline batch -- --fill 3 --delay 4000
```

`.claude/launch.json` defines preview servers: api (:8799, dev auth enabled) and admin (:3000, pointed at :8799).

## Architecture

**API assembly**: `buildApp(opts)` factory (apps/api/src/app.ts) with injectable databaseUrl / appleJwks / devAuth / s3Bucket; tests use `app.inject()` — no ports opened, no business dependencies mocked. `server.ts` is the actual entry point. Route file pattern: `export async function xxxRoutes(app: FastifyInstance)`, registered via `app.register(...)` in app.ts.

**Auth**: `Identity` is the sole credential source — `(provider, subject)` unique, `IdentityProvider` is `APPLE` or `EMAIL` (`User.appleSub` no longer exists). Apple identityToken → verified against Apple JWKS (apple.ts) → `sub`; email OTP → `POST /auth/email/send` issues a code, `POST /auth/email/verify` checks it. Both paths converge on `loginByIdentity` (routes/auth.ts): look up `Identity` by `(provider, subject)` and reuse its `User`, or create both on first login; either way, exchange for a self-signed HS256 session JWT, 180 days (session.ts). OTP security parameters (code length/TTL/cooldown/daily cap/max attempts) live in the `EMAIL_CODE` constant — see apps/api/src/emailAuth.ts, don't duplicate the numbers here. Two guards (auth.ts): `requireUser` (sets `req.userId`) and `requireAdmin` (static ADMIN_TOKEN). Private user-data endpoints and the login-gated public story surfaces (stories / photo-wall in routes/public.ts) take `{ preHandler: requireUser }`; place/card discovery reads stay anonymous (some behind an IP-keyed rate limit); every admin endpoint takes requireAdmin. With `ZHIXING_DEV_AUTH=1`, `POST /auth/dev` provides a dev login bypass (never enable in production) — its `appleSub` body param is the APPLE identity subject, not a `User` column. Tests fake Apple's JWKS with a local keypair (test/helpers.ts: `fakeAppleToken` / `userAuth` / `ADMIN_AUTH`).

**Public vs. private surfaces are physically separated**: all sanitized public reads live in routes/public.ts. The single source of truth for "visible to others" is `PUBLICLY_VISIBLE` in src/visibility.ts (visibility=PUBLIC AND reviewStatus=APPROVED) — never hand-write that condition in a route. Public DTO forbidden fields: userId, appleSub, lat, lng, precise takenAt, email, subject. DTOs must be assembled field by field — never return Prisma entities directly — and every public endpoint needs a regression assertion that the serialized response contains none of the forbidden field names.

**Data model** (packages/db/prisma/schema.prisma): Place is a self-referential tree (PROVINCE → CITY → DISTRICT → POI). A Card is composed of ordered CardBlocks (text/image/audio/video; the last two are reserved for later). Card status machine: AI_GENERATED → REVIEWED → RETIRED (AI_GENERATED cards can go live, badged "AI-generated, pending review" in the app). Footprint carries both visibility and reviewStatus, denormalized likeCount/viewCount counters, and can belong to a Trip. FootprintPhoto ordering is `orderIndex` — reads sort by it, uploads append to it; photo upload/delete/full-reorder live in routes/photos.ts (delete and reorder are owner-scoped and do NOT trigger re-review; reorder validates set equality and is idempotent). The per-footprint photo cap is a named constant on each side — `FOOTPRINT_PHOTO_LIMIT` (apps/api/src/routes/photos.ts) and `ZXLimit.footprintPhotos` (apps/ios/Zhixing/Core/ZhixingLimits.swift) — they can't share code, so change both together; never hardcode the number elsewhere.

**Test strategy**: integration tests hit the real zhixing_test DB (created automatically by docker/initdb; tables via push:test). `resetDb` cleans up with TRUNCATE — **when adding a table, add it to the TRUNCATE lists in both apps/api/test/helpers.ts and packages/db/test/*.ts**, or you'll get dirty-data false failures. Because the test DB is shared: vitest runs with `fileParallelism: false` and the root `pnpm test` uses `--workspace-concurrency=1` — do not re-enable parallelism.

**Storage**: S3-compatible protocol (local MinIO, src/storage.ts); switching to R2/OSS in production is a pure S3_* env-var change, zero code changes.

**Config**: api and pipeline auto-load the repo-root `.env` on startup (each package's src/env.ts via `process.loadEnvFile`). Every setting has a dev default (apps/api/src/config.ts) aligned with docker-compose, so local dev runs with zero configuration.

**Content pipeline**: apps/pipeline/src/llm.ts abstracts the two providers — `ZHIXING_LLM_PROVIDER` picks explicitly, otherwise auto-selected from whichever API key is configured (Gemini preferred). The research step's web search only works on Gemini; DeepSeek skips research and drafts directly. Generated JSON is validated with zod (schema.ts).

**iOS**: apps/ios/project.yml is the single source of truth for the Xcode project — run `xcodegen generate` after changing it (Zhixing.xcodeproj is a build artifact, never edit by hand). Sources are grouped by feature (Map/Place/Footprint/Import/Search/Auth/Me/Core). The API base URL flows from the APP_API_BASE build setting into Info.plist (debug points at localhost:8787; the simulator reaches the host directly). The same target also builds as Mac Catalyst (see scripts/mac-dev.sh, scripts/mac-dmg.sh, docs/mac-install.md).

**Admin**: App Router + plain CSS; all data goes through lib/api.ts client-side fetch, admin token stored in localStorage (`zx_admin_token`), API base from `NEXT_PUBLIC_API_URL`.

## Conventions

- ESM everywhere (`"type": "module"`) + TS strict + NodeNext — relative imports must carry the `.js` suffix.
- Uniform error shape `{ error: string, detail?: any }`; all body validation via zod, failures return 400 `invalid_body`.
- Comments, docs, and commit messages are written in Chinese; commits follow conventional commits (e.g. `feat(api): ...`).
- AGENTS.md is the Codex-facing mirror of this file (same body, different header) — port substantive changes here into it as well.
- All Place lat/lng are GCJ-02 (Mars coordinates) — matches MapKit's mainland-China tiles and AMap picker natively; the display path never converts. Core Location GPS and photo EXIF coords are WGS-84: pass them through `wgs2gcj` (apps/ios/Zhixing/Core/GeoMatch.swift) before distance-matching against Places via `nearestPin` — never feed raw WGS-84 into it. FootprintPhoto EXIF coords are stored as WGS-84 (private data, not rendered on public maps).
