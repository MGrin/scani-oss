# Scani Development Guidelines

This file is the spec contributors (human and agent) ship against in this
repo. Keep it in sync when conventions change.

## Engineering Guidelines

These are non-negotiable. Code that violates them should be either fixed in
place or rejected at review.

- **Bun runtime only.** No `npm` / `pnpm` / `yarn`. Use `bun install`,
  `bun run`, `bun test`, `bun build`. Don't reach for Node-specific APIs
  when a Bun primitive exists (`Bun.file`, `Bun.serve`, `Bun.$`, …).
- **Type-check via `tsgo`** (`@typescript/native-preview`). Every workspace's
  `type-check` script must call `tsgo --noEmit` — do not regress to plain
  `tsc`. tsgo is dramatically faster on this monorepo.
- **Lint via Biome** (`biome.json` at root). No ESLint, no Prettier, no
  parallel formatter. `bun lint:fix` is the only formatting/linting command.
- **Top-level imports only.** No `await import(...)`, no `require()`. If a
  module needs lazy initialization, restructure the boot sequence so
  dependencies are statically resolvable. Existing `await import` calls in
  `apps/backend/{api,worker,data-provider}/src/index.ts` predate this rule
  and are treated as debt — refactor them when touching those files.
- **SOLID, OOP, DRY.** Domain logic lives in `@Service()`-decorated classes
  with class-field DI (see "Dependency Injection" below). One responsibility
  per class. Compose over inherit. If two callers reach for the same logic,
  promote it into the appropriate `packages/*` rather than copy-pasting.
- **Tests live in `tests/` next to `src/`** — e.g.
  `packages/business/domain/tests/services/HoldingService.test.ts`, mirroring
  `packages/business/domain/src/services/HoldingService.ts`. New tests must follow
  this layout. Existing inline `*.test.ts` files (next to source) should be
  migrated to the mirrored `tests/` layout when the surrounding code is touched.
- **`knip` for unused-code, `syncpack` for cross-workspace dep hygiene.**
  Both are wired into CI; both must pass before merge. Run
  `bun run deps:lint` before pushing dependency-touching changes, and
  `bun run deps:unused` before pushing **any** change that adds, deletes
  or stops importing a module — it is the only check here that sees a file
  nothing imports.
- **No `@ts-ignore` / `@ts-expect-error` / `biome-ignore` without a
  one-line justification comment** explaining why the rule has to be
  suppressed at that exact site. If you can't articulate the reason,
  fix the underlying problem instead.
- **Code is documentation.** Default to no comments. Add one only when the
  WHY is non-obvious — a hidden constraint, a subtle invariant, or a
  workaround for a specific bug. Never explain WHAT the code does; the
  code already does that.
- **No dead code, no stubs, no half-finished implementations.** If a
  feature is removed, delete the code. Don't leave commented blocks,
  `// TODO: implement`, or "kept for backwards compatibility" shims when
  nothing actually needs them.
- **Async work goes through BullMQ on Postgres, consumed by `apps/backend/worker`.**
  The api enqueues; it doesn't process long-running work inline. Job state lives
  in the `bullmq` schema of the same database as the application schema;
  `bun run db:migrate` applies both.

## Before Pushing

Always run these checks before pushing:

```bash
# Type check (parallel tsgo --noEmit across all workspaces)
bun run type-check

# Lint + auto-fix (repo-wide via Biome)
bun lint:fix

# Tests — always via the script, never a hand-written path list.
#
# `package.json` is the only place the paths and preloads live, and CI runs
# this exact command. The line that used to be here was a copy of it that had
# drifted to `packages/` alone: measured on this tree, that covers 402 test
# files and SILENTLY SKIPS 207 — 51 under `apps/backend/`, 128 under
# `apps/frontend/`, 28 under `scripts/`. Among them is the route-split guard
# this file tells you protects the build. It also dropped the second preload,
# `apps/frontend/app/tests/i18n-preload.ts`, which every frontend test needs.
#
# A subset that passes reports the same green as the whole suite. That is the
# entire reason this is a script and not a command you retype.
#
# Needs the compose Postgres up and migrated — see **Local Development** below:
# `docker compose up -d postgres` then `bun run db:migrate`.
bun run test

# Docker Hub descriptions match the images. Fast (0.13s), no services. It
# validates every `docker-readmes/*.md` against the 100-char cap Docker Hub
# enforces on a short description, and reconciles the directory against the
# image set in `scripts/lib/docker-images.ts` — an image with no README, or a
# README with no image, exits 1 and names it. CI runs this exact command;
# running it here saves the round trip.
bun scripts/sync-dockerhub-readme.ts --check

# Docs match source, and every `.mdx` page under
# `apps/frontend/docs/src/content/` compiles. Fast (~0.4s), no services. CI
# runs this too, but running it here turns an MDX syntax error into a named
# file and line instead of a red `Build site` job after the fact — and MDX is
# stricter than Markdown in ways that do not look like mistakes. A Markdown
# autolink, `<http://localhost:8080>`, is correct in a `.md` page and is read
# as a JSX tag in an `.mdx` one.
bun run docs:check

# COMMIT a deletion before running the two checks above — staging it is not
# enough, and `docs:check` passing is what makes that look settled.
# `check-docs.ts` reads `git ls-files`, which honours the index, so a staged
# deletion is already invisible to it. But
# `scripts/tests/check-docs-compiles-mdx.test.ts` runs the same script against
# a scratch index built from `read-tree HEAD`, where your deletion has not
# happened — so the file reads as tracked and missing and the run dies with
# `[checkEnvVarCoverage] crashed: ENOENT`, naming a path you correctly
# deleted. Measured on seven staged deletions: `docs:check` green, that test
# 4 pass / 2 fail, and committing is the whole fix.

# When you touched apps/frontend/docs. `docs:check` above compiles the pages;
# the build additionally validates frontmatter against the content schema,
# resolves component imports and link targets, and asserts on the rendered
# tables. ~6s for 60 pages, no services.
#
# Note the flag order. `bun --cwd DIR run build` prints bun's help and exits 0,
# so the wrong form is a documented step that silently does nothing.
bun --cwd apps/frontend/docs build

# Unused files and dependencies. Run this whenever you added, deleted or
# stopped importing a module — NOT only when a manifest changed. This was
# `knip --dependencies`, which reports dependency issues and no unused FILES
# at all, so a module nothing imports could sit here indefinitely: seven did,
# totalling 983 lines, one of them a 323-line copy of a live module. Exit 1
# names each unused file. Unused EXPORTS stay off in `knip.json` on purpose.
bun run deps:unused

# When dependencies changed
bun run deps:lint    # syncpack — version alignment
```

## Pushing & Pull Requests

**Every push to a branch MUST be accompanied by an open pull request.** Pushing
without opening (or already having) a PR for the branch is not allowed — the
only exception is a broken environment that physically prevents PR creation
(GitHub API unreachable, repo scope blocked), in which case the failure must
be reported back to the user, not silently skipped.

Before pushing, check the branch's state on the remote:

1. If the branch has **no PR**, push and immediately open one.
2. If the branch has an **open PR**, push the new commits to it — do not
   open a second PR for the same branch.
3. If the branch's PR is **merged or closed**, the branch is retired. Do
   not push more commits to it. Create a new branch off the latest base
   (typically `main`), and open a new PR from that branch instead. Pick a
   distinct branch name — append a suffix like `-2`, `-followup`, or a
   short topic keyword rather than reusing the old name.

This rule covers every push, including follow-up pushes triggered by PR
review feedback, CI babysitting, or autofix loops. If a session is asked
to "push the fix" against a branch whose PR has already merged, treat
that as a new piece of work and create a fresh branch + PR.

## Repo Layout

Bun workspaces monorepo. Apps split into two top-level categories — `backend/`
(HTTP services + the BullMQ worker that handles all scheduled +
user-initiated async work) and `frontend/` (the browser SPA + docs site) —
plus the cross-cutting `apps/e2e` Playwright suite.

**Backend apps (`apps/backend/`):**
- `apps/backend/api` — tRPC API on Elysia; BullMQ *producer*; per-user
  credentialed integrations (exchanges, brokerages) live here so creds don't
  cross the tenant boundary.
- `apps/backend/worker` — BullMQ *consumer*; runs every scheduled +
  user-initiated job in one binary. Repeatable schedules (pricing,
  wallet/exchange balance syncs, APY payouts, historical-price backfill,
  forex backfill, portfolio-value rollup, transfer linking, token-identity
  backfill, orphan reconcilers) live in
  `packages/infra/queue/src/queue-names.ts:REPEATABLE_SCHEDULES`; the worker
  registers them with BullMQ at boot. There is no separate cron app.
- `apps/backend/data-provider` — tRPC service fronting a *subset* of
  outbound third-party calls: **object storage (R2), email (JMAP / SMTP),
  OG-metadata fetching, and token search**. The same binary serves all
  three deployment tiers.

  **It is not the sole egress, and the api and worker DO call upstream
  pricing and AI APIs directly.** All three backend apps boot
  `buildProviderRegistry({ mode: 'direct' })` — `api/src/index.ts`,
  `worker/src/index.ts`, `data-provider/src/index.ts` — so CoinGecko,
  DeFiLlama, Frankfurter, Finnhub, Yahoo Finance, Etherscan, the chain
  RPCs and OpenAI are constructed and called in each process. Google
  Sheets is registered in the api and worker only — *not* here.

  **Credentialed calls in particular do NOT flow through this service.**
  The user-credentialed CEX/broker/fiat providers stay in the api and
  worker deliberately, so decrypted per-tenant credentials never cross
  into a shared multi-tenant service.

  A `mode: 'cloud'` exists (`packages/clients/providers/src/core/cloud/`
  plus `CloudProviderClientBridge` in `@scani/cloud-client`) that would
  make the sole-egress claim true for pricing/AI/token-identity. **No app
  uses it**, and nothing constructs the bridge outside tests, so this
  service's `ai.*` and `pricing.*` routers have no live caller. Do not
  reason about egress as though it were wired up.

  What makes upstream budgets coherent across those processes is **Redis,
  not topology**: `buildProviderRegistry` calls `setSharedRedis`, and
  `OutflowRateLimiterRegistry` keys every limiter `rl:<namespace>` with no
  per-service discriminator, so one window is shared by every process. An
  in-process limiter would multiply every agreed cap by the process count.

  **Set every provider API key on the api and worker too**, not only here —
  see `.env.example`. Missing keys degrade silently rather than failing at
  boot.

**Frontend apps (`apps/frontend/`):**
- `apps/frontend/app` — Main React + Vite SPA (code under `src/v2/`).
- `apps/frontend/docs` — Astro docs site (type-checked with `astro check`,
  the one sanctioned exception to the `tsgo --noEmit` rule).

**E2E (`apps/e2e`):** Playwright suite driving the full containerized stack
(`bun test:e2e` runs `scripts/run.ts`, which boots the compose profile,
runs the browser tests against it, and tears it down).

**Packages:** organized by role into four category folders.

**`packages/business/`** — domain logic + the wire contract. Things that change when the product changes.
- `packages/business/domain` — Services, repositories, use cases (the bulk of business logic).
- `packages/business/jobs` — Async-job catalog: per-job descriptors (payload schemas, retry policies, jobId strategies, summarizers), repeatable schedules, and the `@scani/queue` mirror/lock impls. Apps import descriptors from here; processor classes live in `apps/backend/worker`.
- `packages/business/shared` — Frontend-safe contract: zod DTOs (the tRPC wire) + the project-configured `Decimal.js` instance + UI helpers (`formatCurrency`, `formatRelative`, `emailSchema`, …). Strict rule: no Node-only APIs reachable from the barrel.
- `packages/business/file-import` — Bank-statement parsing primitives (CSV / OFX / QIF / IB-CSV + format detection). Pure functions; the AI fallback for CSV column mapping is a caller-injected callback so the package never imports `@scani/domain`.
- `packages/business/ingesters` — Transaction-ingester registry + statement/screenshot ingesters. Leaf package: callers inject the AI screenshot-parser callback at construction, same no-`@scani/domain` rule as `file-import`.

**`packages/infra/`** — pure system concerns. No business knowledge; reusable in any TypeScript backend.
- `packages/infra/db` — Drizzle schema, migrations, postgres.js connection, `BaseRepository`.
- `packages/infra/queue` — Async-coordination framework on BullMQ. Abstract bases (`UserJobProcessor`, `ScheduledJobProcessor`, `EnqueueService`, `JobLock`, `ResourceLock`, `LifecyclePublisher`) + concrete `@Service()` impls (`QueueClient`, `WorkerClient`, `JobScheduler`, `BullMqEnqueueService`, `RedisLifecyclePublisher`, `RedisResourceLock`). Domain-free — per-job knowledge lives in `@scani/jobs`.
- `packages/infra/email` — Email sending (Fastmail JMAP / SMTP).
- `packages/infra/logging` — Structured logging (pino).
- `packages/infra/security` — Secret-handling: AES-256-GCM credential encryption with scrypt-derived keys; `ENCRYPTION_KEY` env-self-loaded; refuses to start in production without a key.
- `packages/infra/storage` — Object storage abstraction (any S3-compatible store).
- `packages/infra/realtime` — Realtime / SSE pub-sub via Redis.
- `packages/infra/rate-limiter` — Resilience primitives for upstream calls: rate limiting (Redis-backed in prod, in-memory fallback in tests), per-provider circuit breakers, retry-with-backoff.
- `packages/infra/config` — Env-validation primitives (`requiredInProd`, `httpsUrlInProduction`, …) consumed by every app's startup schema.
- `packages/infra/http-fetch` — Bounded HTTP fetcher for Open Graph metadata + similar fixed-budget pulls. SSRF-guarded, size-capped, timeout-bounded. Pure functions; no DI.
- `packages/infra/push` — Web Push transport: VAPID config + an encrypted send that reports a gone subscription (`isSubscriptionGone`) and a VAPID-key mismatch as distinct outcomes rather than errors, so a caller prunes the subscription instead of retrying it.
- `packages/infra/deadline` — A bound on one `await` of a remote dependency (`withRedisTimeout`), plus the error it rejects with. Zero dependencies on purpose: `queue`, `rate-limiter` and `domain` all take it, and none of them may take each other.

**`packages/clients/`** — outbound network adapters. Same dependency direction (business → clients → external world).
- `packages/clients/providers` — **Unified 3rd-party integration package**: pricing, balances, transactions, AI inference, token-identity. Capability-based interfaces, one directory per provider (CoinGecko, DeFiLlama, Kraken, Binance, IBKR, Wise, OpenAI, Google Sheets, …). Single source of truth for every external service.
- `packages/clients/providers-google-sheets` — `GoogleSheetsProvider` sub-workspace of `@scani/providers` carrying the heavy `googleapis` dep so the rest of the providers tree (and `@scani/domain` transitively) stays slim.
- `packages/clients/cloud-client` — Typed tRPC client for the `data-provider` service. The api + worker call the data-provider through this rather than reaching for HTTP directly.

**`packages/frontend/`** — browser-only.
- `packages/frontend/ui` (`@scani/ui`) — Design system + shared client plumbing for the SPA. Ships the Tailwind preset + CSS tokens, the full shadcn primitive set (button/card/input/dialog/select/popover/sheet/table/textarea/checkbox/command/progress/loading/etc.), `ThemeContext`, `ErrorBoundary`, `UpdateBanner`, `MagicCodeInput`, the `useAppUpdate` hook, PWA helpers, and the `createScaniAuthClient` / `createTrpcProvider` factories. Consumed by `frontend/app`. **`apps/frontend/app` is the canonical source of truth** — when promoting a new shared primitive, copy from there.

## Key Paths

- tRPC routers: `apps/backend/api/src/presentation/routers/`
- Queue names + enqueue helpers: `packages/infra/queue/src/{queue-names,enqueue}.ts`
- Worker processors (scheduled + user-initiated): `apps/backend/worker/src/processors/`
- Repeatable schedules registry: `packages/business/jobs/src/scheduled-jobs/` (one descriptor per cron job)
- Domain services / repositories / use cases: `packages/business/domain/src/`
- DB schema: `packages/infra/db/src/schema/` (one file per entity bundle; `schema/index.ts` is the barrel)
- Drizzle migrations: `packages/infra/db/src/migrations/` (register custom SQL in `meta/_journal.json`)
- Provider registry: `packages/clients/providers/src/`
- Data-provider tRPC routers: `apps/backend/data-provider/src/presentation/`
- Test preload: `packages/business/domain/test-preload.ts`

## Dependency Injection (typedi) — class-field pattern, not constructor params

**The rule**: in any `@Service()`-decorated class, use class-field initializers
with `Container.get(Dep)`. Do **not** use constructor-param injection.

```ts
// ✅ Correct — what all working services in this repo do
@Service()
export class MyService {
  private readonly repo = Container.get(MyRepository);
  private readonly other = Container.get(OtherService);
  // no constructor, or `constructor() {}` if you need a hook
}

// ❌ Wrong — silently broken at runtime
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository, // typedi injects ContainerInstance here
    private readonly other: OtherService, // same
  ) {}
}

// ❌ Also wrong — `= Container.get(…)` defaults do NOT fire because
// typedi actively passes a (bogus) value for each parameter
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository = Container.get(MyRepository),
  ) {}
}
```

**Why**: Bun's TypeScript transpiler does not emit `design:paramtypes`
reflect-metadata for decorators. typedi's constructor-param injection relies
on that metadata to resolve types; when it's missing, typedi falls back to
injecting its own `ContainerInstance` into every slot. The field on the
class then "exists" but is actually typedi itself, and you get runtime
errors like `this.foo.someMethod is not a function`. Tests pass (they
call `new Service(stub)` directly) while production breaks — so this is
extra-silent.

**Testing services that use class-field DI**: seed stubs on the Container,
then construct a fresh instance. Don't `Container.reset()` / `Container.remove()`
— either wipes the `@Service()` registration.

```ts
function makeService(stubDep: Dep): MyService {
  Container.set(MyRepository, stubDep);
  const instance = new MyService();      // class-field initializers run now,
  Container.set(MyService, instance);    // reading the stub we just set
  return instance;
}
```

See `packages/business/domain/src/services/HoldingService.ts` as a canonical
example, and `BalanceAtTimeService.test.ts` / `PriceGraphService.test.ts` for
the stubbed-DI test pattern.

## Testing

- **Runner**: `bun test`. No Jest, no Vitest.
- **Layout**: tests live in `tests/` next to `src/`, mirroring the source
  tree — e.g. `packages/business/domain/tests/services/HoldingService.test.ts`
  for `packages/business/domain/src/services/HoldingService.ts`. New tests
  must use this layout. Existing inline `*.test.ts` files (next to source)
  should migrate to the mirrored `tests/` layout when their surrounding
  code is touched.
- **Preload**: shared preload at `packages/business/domain/test-preload.ts` —
  loads `reflect-metadata` (required for `@Service()` decorators) and sets
  a default `DATABASE_URL` pointed at the docker-compose Postgres
  (`localhost:5433`). The CI test job runs with this preload globally.
- **Per-test isolation**: repository tests wrap each body in a transaction
  via `withTestDb` (see `packages/business/domain/test/helpers/db.ts`) and
  roll back on exit, so suites can run in parallel against the same DB.
- **Stubbed-DI pattern**: `Container.set(Dep, stub); new Service();` —
  never `Container.reset()` (it wipes the `@Service()` registration).
  See examples in `packages/business/domain/tests/services/BalanceAtTimeService.test.ts`
  and `PriceGraphService.test.ts`.
- **Coverage**: `bun test --coverage` (per-package, on-demand). Not run in CI.

## Environment Variables

Two layers, with a strict ownership rule.

**App-level (`apps/*/src/config/env.ts`)** owns env vars that belong to the
*app itself* — its bind port, its database connection string, its frontend
origin, its session-signing secrets, its Sentry DSN. Each app declares a
zod `envSchema`, parses `process.env` once at boot, exits with a clear error
listing every failing variable, and caches the result via `loadEnv()`. The
schema imports shared helpers from `@scani/config`:

- `isProduction` — `process.env.NODE_ENV === 'production'` evaluated at
  module load.
- `urlSchema` / `httpsUrlInProduction` — base URL validators with the
  prod-only https requirement.
- `requiredInProd(schema, varName)` — returns the schema unchanged in prod
  and `schema.optional()` everywhere else, so dev/test boots without the
  variable but production refuses to start without it.

Examples: `apps/backend/api/src/config/env.ts`,
`apps/backend/worker/src/config/env.ts`.

**Package-level (`packages/infra/<pkg>/src/config.ts`)** owns env vars that
belong to *that package* — `FASTMAIL_API_TOKEN` / `SMTP_URL` / `SMTP_FROM`
for `@scani/email`, `S3_*` for `@scani/storage`, `ENCRYPTION_KEY` for
`@scani/security`. Each package:

1. Defines a zod schema in `src/config.ts` (or inline for single-service
   packages like `@scani/storage`).
2. Depends on `@scani/config` for `isProduction` / `requiredInProd` / URL
   helpers and on `zod` directly.
3. Uses `isProduction` (or `requiredInProd`) so the variable is **optional
   in dev/test** and **required in production** — production failures are
   non-recoverable misconfigurations, dev passthroughs let contributors
   boot without ceremony.
4. Exports a `loadXConfig()` that lazily parses and caches, plus a
   `resetXConfig()` for tests, and throws
   `@scani/<pkg> env misconfigured:\n  - VAR: <message>` on failure.
5. Calls the loader from inside the service / helper on first use — never
   reads `process.env.<X>` directly outside `config.ts`.

**Apps that depend on a package MUST NOT redeclare that package's env vars
in their own `envSchema`.** The package owns validation; the app just sets
the env var and trusts the package's loader. Comments in the app's env.ts
should call out the delegation (see the `ENCRYPTION_KEY` / `S3_*` /
`FASTMAIL_API_TOKEN` notes in `apps/backend/api/src/config/env.ts`).

When you add a new package that needs config:

```ts
// packages/infra/<pkg>/src/config.ts
import { isProduction } from '@scani/config';
import { z } from 'zod';

const envSchema = z.object({
  MY_API_KEY: isProduction
    ? z.string().min(32, { message: 'MY_API_KEY required in production' })
    : z.string().min(1).optional(),
});

export type MyConfig = z.infer<typeof envSchema>;

let cached: MyConfig | null = null;

export function loadMyConfig(env: NodeJS.ProcessEnv = process.env): MyConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/<pkg> env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetMyConfig(): void {
  cached = null;
}
```

Reference implementations: `packages/infra/email/src/config.ts`,
`packages/infra/security/src/config.ts`,
`packages/infra/storage/src/storage-service.ts` (inline schema variant).

## Dependency Hygiene

- **`bun run deps:lint`** — syncpack: enforces internal `@scani/*` packages
  pinned to `workspace:*`, all external deps share a single version across
  workspaces, and external deps use a caret range (`^`). `@types/bun` is
  exempt and tracks Bun's release cadence via `latest`. Config:
  `.syncpackrc.json`.
- **`bun run deps:fix`** — syncpack auto-fix.
- **`bun run deps:unused`** — `knip --dependencies --include files,exports,types`:
  unused **files, exports and types** plus unused / unlisted / unresolved
  dependencies. All three are gated as of SC-558 (`7b8064463`) — this entry
  said exports and types were `off` until SC-739, describing the tree before
  it. `knip.json`'s `rules` block carries `"exports": "error"` and
  `"types": "error"`; what remains `"off"` is the narrower `nsExports`,
  `nsTypes` and `enumMembers`, so this was a coarse exclusion replaced by a
  precise one rather than a switch flipped. The counts that used to sit here,
  "79 and 70", described the pre-SC-558 tree; SC-558's own subject says it
  triaged 133, and neither is reconciled with the other because there is no
  basis to prefer either. Test files (`**/*.test.ts`) are excluded from the
  scan.
  `scripts/*.ts` and `apps/e2e/scripts/*.ts` are declared as entry points
  because they are invoked by hand or by a shell script and knip cannot infer
  either; without that the run reports them all as unused, including
  `sync-dockerhub-readme.ts`, which the before-pushing list above runs.
  `scripts/lib/` and `scripts/tests/` are deliberately NOT entry points, so a
  dead helper under them is still reportable. Config: `knip.json`.
- **`bun run deps:outdated` / `bun run deps:update:minor`** — version drift
  checks and minor-bump updates.
- CI runs `deps:lint` and `deps:unused` whenever lockfile/config files
  **or any source file** change. Both must pass. The source half matters:
  gated on manifests alone, the unused-file check never ran on the kind of
  change that creates or should have removed a dead module.

## Infrastructure

Backend apps (api, worker, data-provider) ship as multi-stage Bun Docker
images and run on any container host. A reference self-host setup using
Postgres, Redis, and S3-compatible storage is wired in
[`docker-compose.yml`](./docker-compose.yml) for local development; a
production-flavour `docker-compose.prod.yml` pulls pre-built images. The
frontend app builds as a static SPA and serves from any static host.

Choice of provider for each layer is up to the operator:

- **Postgres** — any 16+ instance (Neon, Render, RDS, self-hosted, …).
- **Redis** — any 7+ instance (Upstash, Redis Cloud, self-hosted, …).
- **Object storage** — any S3-compatible store (MinIO locally, Cloudflare
  R2, AWS S3, Backblaze B2, …).
- **Email** — SMTP or Fastmail JMAP via `FASTMAIL_API_TOKEN`.
- **Auth** — Better-Auth (no external auth provider required).

## CI / CD

Workflows in `.github/workflows/`:

- `ci.yml` — path-filtered jobs:
  - `validate-code` — Biome lint + parallel `tsgo --noEmit` across all workspaces.
  - `validate-deps` — runs `bun run deps:lint`, `bun run deps:unused` and
    `bun run ci:gen:check` (when lockfile/config files **or** source files
    changed). It invokes the package scripts rather than inlining their flags,
    and so does this line as of SC-739: the flags were copied into prose here
    and drifted at SC-558 without anything noticing.
  - `test` — Postgres 16 service container; runs `bun run db:migrate`
    then `bun test --preload ./packages/business/domain/test-preload.ts $PATHS --timeout 30000`.
  - `secret-scan` — grep-based secret detection (always runs).
- `docker-publish.yml` (planned) — multi-arch image build & publish to a
  public container registry.

## Async Queue System (BullMQ)

Single Postgres-backed queue (`scani-jobs`) plus a dead-letter queue
(`scani-dlq`), on BullMQ's Postgres backend — the `bullmq` schema of
`DATABASE_URL`, not Redis.
The api enqueues; `apps/backend/worker` consumes everything. Job names +
repeatable schedules are defined in `packages/infra/queue/src/queue-names.ts` —
the worker registers the schedules with BullMQ at boot via
`upsertJobScheduler`, so there is no separate cron app.

**Repeatable jobs** (cron strings live in
`packages/business/jobs/src/scheduled-jobs/*.ts` — that file is the
single source of truth; this list is for navigation only):
`pricing`, `wallet-balances`, `exchange-balances` (hourly);
`apy-payouts` (daily midnight UTC); `historical-price-backfill` (03:00),
`forex-backfill` (03:30), `transfer-linking` (03:45),
`portfolio-value-rollup` (04:00), `hide-closed-holdings` (04:30) —
nightly chain; `backfill-token-identity` (weekly Sunday 02:00 UTC);
`reconcile-pending-credentials`, `reconcile-orphaned-user-jobs`
(every minute, sweep stuck rows); `dlq-depth-probe` (every 5 min),
`job-heartbeat-probe` (every 10 min).

**User-initiated jobs**: `screenshot-parse`, `exchange-import`, `wallet-import`,
`file-import`, `holding-price-update`, `manual-holdings-create`,
`portfolio-history-backfill`, `refresh-account-balance`,
`transaction-import`, `user-data-delete`.

Local: jobs aren't processed unless the worker is running
(`bun dev:worker` against the compose infra, or `docker compose --profile full up`).
Each scheduled processor wraps in a Postgres advisory lock
(`apps/backend/worker/src/lib/cron-lock.ts`) so two overlapping fires of the
same job-name silently no-op rather than racing.

Operator tooling can call HMAC-gated job endpoints on the api
(retry / remove / DLQ replay) signed with `JOBS_HMAC_SECRET`.

## Local Development

`docker-compose.yml` uses non-default host ports to avoid clashes:

| Service | Host port | Notes |
|---|---|---|
| Postgres | `localhost:5433` | `postgres` container |
| Redis | `localhost:6380` | `redis` container |
| Mailpit SMTP | `localhost:1026` | Submit mail here |
| Mailpit UI | `http://localhost:8026` | Inspect dev emails |
| MinIO (S3) | `localhost:9000` | Local S3-compatible store |
| MinIO console | `http://localhost:9001` | `minioadmin` / `minioadmin` |
| data-provider | `localhost:8082` | Tier-1 sidecar (incl. email.send tRPC) |
| api | `localhost:3001` | Elysia tRPC API |
| frontend/app | `http://localhost:5173` | Main SPA |

### Starting the stack

Full stack (`api` + `worker` + `data-provider` + `frontend/app` in containers, recommended):

```bash
bun dev:stack          # runs scripts/sync-env.ts, then `docker compose --profile full up -d --build`
bun dev:stack:down     # stops and removes compose containers (volumes preserved)
```

Infra only — Postgres, Redis, MinIO and Mailpit and nothing else. This is
the right stack for **running the test suite**, and for `bun dev` against
containerized services:

```bash
bun dev:stack:infra    # sync-env, then `docker compose up -d --build --wait`
bun install
bun dev                # api + frontend/app concurrently; other apps via bun dev:worker / dev:data-provider
```

`bun run test` reaches those four and never touches a vite dev server, the
api or the worker — so a gate run on the full stack idles the rest hot for
its whole duration. Measured during a live gate, the three largest consumers
on a 10-core box were the frontend dev servers this mode omits (SC-706).

**Do not reach for `docker compose up -d postgres redis mailpit minio`,
which is what this section used to say.** It is not merely undocumented, it
is worse than the waste it saves, and it fails in two ways that are not
alike:

- **Silent, and it reaches outside your worktree.** It exports nothing, so
  compose takes the project name from the directory leaf — `scani` in every
  linked worktree — and a second `up` does not conflict with the first, it
  **adopts and recreates** the primary checkout's containers (SC-491).

  **The primary checkout is not where this is safe, it is where it arms the
  trap**, so do not read the warning as worktree-only. Observed in practice: a
  compose project literally named `scani` running for hours, its
  `working_dir` label pointing at the primary checkout, because someone ran
  this exact line there. That is the container a linked worktree then adopts —
  so both halves of the hazard are one instruction executed in two places.

  It is not "unsafe in a worktree, fine at home" either. `bun dev:stack` in the
  primary checkout derives its own project name and still wants `5433`, so a
  bare `scani` project makes the supported path fail to bind there too.

  Check for one with the LABEL. `docker compose ls -a --format '{{.Name}}'`
  omitted the row while the project was demonstrably running, and a template
  that silently drops a row reads exactly like an absent project:

  ```bash
  docker ps -a --filter 'label=com.docker.compose.project=scani'
  ```
- **Loud and safe.** It publishes `${POSTGRES_HOST_PORT:-5433}`, while
  `gate-db` derives its own port from a sha256 over this worktree's absolute
  path. The gate then finds nothing there and refuses with exit 3, NO TESTS
  RAN.

Only the second one tells you. `bun dev:stack:infra` makes both impossible
because it is the one place the project name and every derived port are
computed together — the same code path `bun dev:stack` uses. If you must run
compose by hand, `export $(bun scripts/dev-stack.ts env | xargs)` first.

`bun dev:stack:down` tears down either mode; it does not need to know which
one you started.

### Tear the stack down BEFORE you delete the checkout (SC-803)

**The order is the reverse of the natural one, and getting it wrong strands the
stack permanently.** A checkout's stack is isolated by its compose PROJECT NAME,
derived from the checkout's absolute path (SC-491). Delete the directory and the
name can no longer be produced, so `bun dev:stack:down` — which has to run from
the directory it is tearing down — is unavailable exactly when it is needed.

**The by-hand attempt is worse than unavailable, because it SUCCEEDS.** Measured
2026-09-02, and re-measured on a stack stood up for the purpose:

```
cd <checkout> && docker compose down --volumes --remove-orphans
  ->  rc=0, ZERO bytes of output, and all four containers still running
```

`docker-compose.yml` names no containers, so a bare `down` takes the project
from the DIRECTORY LEAF — `scani` in every linked worktree of this repository, a
project that holds nothing. It is a well-formed no-op that reports success: the
removal-side twin of the `up` adoption hazard above.

So: **`bun dev:stack:down` first, `git worktree remove` second.**

**If you already did it the other way round, `bun run dev:stacks:reap`** is the
recovery, and it needs no compose file — `docker compose -p <project> down` finds
containers, networks and volumes by their labels, so it still works after the
directory is gone.

```bash
bun run dev:stacks              # report only; stops and removes nothing
bun run dev:stacks:reap         # DRY RUN — says what it would take, touches nothing
bun run dev:stacks:reap -- --apply
bun run dev:stacks:reap -- --project <name> --apply    # one project, same guard
```

**Dry run is the default and `--apply` is the only way past it.** What it removes
are per-checkout dev volumes — a Postgres, a Redis, a MinIO — which a later
`bun dev:stack` recreates and migrates from scratch. But "recreatable" is a claim
about the SCHEMA, not about whatever somebody put in one, and the person who
would know went with the checkout.

**Every way of not knowing REFUSES rather than reclaiming**, and it exits with a
distinct code so a caller can tell them apart:

| exit | what happened |
|---|---|
| 3 | docker could not be asked. An empty list is what a denied socket returns AND what a clean machine returns, so this refuses rather than picking one |
| 4 | `git worktree list` could not be answered, so no project can be attributed. This is the one that would do damage: the fallback is "this checkout is the only one", which would put every OTHER live stack outside the live set |
| 5 | `--project` named something that is not reclaimable, and says which state it is in |
| 1 | a teardown was attempted and could not be verified as finished |

A project is reclaimed only when its name is a derivation no live checkout
produces. A live checkout whose stack is merely DOWN is never reclaimable —
somebody may return to it — and neither is a project whose name is not a
derivation at all (the bare `scani` a hand-rolled `docker compose up` produces),
because it may be serving the primary checkout right now.

**In the agent sandbox the docker socket is denied and the denial reads as an
EMPTY LIST**, so this is exit 3 rather than a false "nothing to reclaim". Run it
unsandboxed.

### Mail in dev

All auth emails (magic-link, OTP, verification) land in Mailpit at
`http://localhost:8026`. Flow: `api → email.send tRPC → data-provider → SMTP → mailpit:1025`.

The `data-provider` service hardcodes `FASTMAIL_API_TOKEN: ""` in compose
to force SMTP even when your shell / root `.env` has a real Fastmail
token. To test Fastmail in dev, comment out that line in
`docker-compose.yml`. For host-side `bun dev`, add
`SMTP_URL=smtp://localhost:1026` and `SMTP_FROM=no-reply@scani.local`
to the root `.env` and re-run `bun scripts/sync-env.ts`.

### Gotchas

- **One-shot containers linger after clean exit.** `env-sync`, `deps`,
  `migrate`, `minio-init` all `restart: "no"` and keep their names reserved
  after exiting. `bun dev:stack:down` removes them; `compose up` without
  prior `down` will hit a name-conflict error.
- **Host-side `bun dev` needs SMTP in root `.env`.** The containerized stack
  overrides `SMTP_URL` via compose environment; host-side api reads
  `apps/backend/api/.env` (generated from root `.env` by `scripts/sync-env.ts`),
  which will have no SMTP config unless you add it to root `.env` first.
