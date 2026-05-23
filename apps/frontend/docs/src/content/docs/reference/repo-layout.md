---
title: Repo layout
description: How the monorepo is organized — apps, packages, and what each one owns.
---

Bun workspaces monorepo. Apps split into two top-level categories.

## `apps/`

### `apps/backend/`

- **`api`** — tRPC API on Elysia; BullMQ *producer*; per-user credentialed
  integrations (exchanges, brokerages) live here so creds don't cross the
  tenant boundary.
- **`worker`** — BullMQ *consumer*; runs every scheduled + user-initiated
  job in one binary. Repeatable schedules live in
  `packages/infra/queue/src/queue-names.ts:REPEATABLE_SCHEDULES`; the
  worker registers them with BullMQ at boot.
- **`data-provider`** — tRPC service that centralizes outbound third-party
  calls (CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Google Sheets,
  OpenAI, Perplexity, DeepSeek). The same binary serves all three
  deployment tiers.

### `apps/frontend/`

- **`app`** — main React + Vite SPA (code under `src/v2/`).
- **`docs`** — this site (Astro + Starlight).

## `packages/`

Organized by role into four category folders.

### `packages/business/` — domain logic + the wire contract

Things that change when the product changes.

- **`domain`** — Services, repositories, use cases (the bulk of business
  logic).
- **`jobs`** — Async-job catalog: per-job descriptors (payload schemas,
  retry policies, jobId strategies, summarizers), repeatable schedules,
  and the `@scani/queue` mirror/lock impls. Apps import descriptors from
  here; processor classes live in `apps/backend/worker`.
- **`shared`** — Frontend-safe contract: zod DTOs (the tRPC wire) + the
  project-configured `Decimal.js` instance + UI helpers (`formatCurrency`,
  `formatRelative`, `emailSchema`, …). **Strict rule:** no Node-only APIs
  reachable from the barrel.

### `packages/infra/` — pure system concerns

No business knowledge; reusable in any TypeScript backend.

- **`db`** — Drizzle schema, migrations, postgres.js connection,
  `BaseRepository`.
- **`queue`** — Async-coordination framework on BullMQ. Abstract bases
  (`UserJobProcessor`, `ScheduledJobProcessor`, `EnqueueService`,
  `JobLock`, `ResourceLock`, `LifecyclePublisher`) + concrete `@Service()`
  impls. Domain-free.
- **`email`** — Email sending (Fastmail JMAP / SMTP).
- **`logging`** — Structured logging (pino).
- **`security`** — Secret-handling: AES-256-GCM credential encryption
  with scrypt-derived keys.
- **`storage`** — Object storage abstraction (any S3-compatible store).
- **`realtime`** — Realtime / SSE pub-sub via Redis.
- **`rate-limiter`** — Resilience primitives for upstream calls:
  rate limiting (Redis-backed in prod, in-memory fallback in tests),
  per-provider circuit breakers, retry-with-backoff.
- **`config`** — Env-validation primitives (`requiredInProd`,
  `httpsUrlInProduction`, …) consumed by every app's startup schema.

### `packages/clients/` — outbound network adapters

Same dependency direction (business → clients → external world).

- **`providers`** — Unified 3rd-party integration package: pricing,
  balances, transactions, AI inference, token-identity. Capability-based
  interfaces, one directory per provider. Single source of truth for
  every external service.
- **`cloud-client`** — Typed tRPC client for the `data-provider` service.

### `packages/frontend/` — browser-only

- **`ui`** (`@scani/ui`) — Design system + shared client plumbing for the
  SPA. Ships the Tailwind preset + CSS tokens, the full shadcn primitive
  set, `ThemeContext`, `ErrorBoundary`, `UpdateBanner`, `MagicCodeInput`,
  the `useAppUpdate` hook, PWA helpers, and the
  `createScaniAuthClient` / `createTrpcProvider` factories.

## Key paths

| What                                          | Where                                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| tRPC routers                                  | `apps/backend/api/src/presentation/routers/`                |
| Queue names + enqueue helpers                 | `packages/infra/queue/src/{queue-names,enqueue}.ts`         |
| Worker processors                             | `apps/backend/worker/src/processors/`                       |
| Repeatable schedules registry                 | `packages/business/jobs/src/scheduled-jobs/`                |
| Domain services / repositories / use cases    | `packages/business/domain/src/`                             |
| DB schema                                     | `packages/infra/db/src/schema/`                             |
| Drizzle migrations                            | `packages/infra/db/src/migrations/`                         |
| Provider registry                             | `packages/clients/providers/src/`                           |
| Data-provider tRPC routers                    | `apps/backend/data-provider/src/presentation/`              |
| Test preload                                  | `packages/business/domain/test-preload.ts`                  |
