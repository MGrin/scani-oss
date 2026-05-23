---
title: Architecture
description: The four services that make up Scani, and how they wire together.
---

```
┌────────────────────────────────────────────────────────────────────────┐
│  Browser  ──HTTPS──▶  api (Elysia + tRPC)  ──BullMQ──▶  worker         │
│                            │                             │             │
│                            └──┬──────────────────────────┘             │
│                               │ over tRPC                              │
│                               ▼                                        │
│                       data-provider                                    │
│                  (centralized 3rd-party calls:                         │
│                   CoinGecko, Finnhub, DeFiLlama, OpenAI,               │
│                   Etherscan, Helius, Google Sheets, …)                 │
│                                                                        │
│  Postgres ◀─── api + worker + data-provider (Drizzle)                  │
│  Redis    ◀─── api (BullMQ producer) + worker (BullMQ consumer)        │
│  S3       ◀─── worker (screenshot uploads, file imports)               │
└────────────────────────────────────────────────────────────────────────┘
```

## The four services

### `apps/backend/api`

tRPC + Elysia HTTP server. Owns per-user credentialed integrations (exchange
API keys, brokerage tokens) so user creds never cross the tenant boundary.
Also the BullMQ *producer* — it enqueues every async job; it doesn't process
long-running work inline.

### `apps/backend/worker`

BullMQ consumer. Runs every scheduled job (pricing refresh, balance syncs,
historical backfills, transfer linking) and every user-initiated job
(screenshot parse, import, delete) in one binary. There is no separate cron
app — repeatable schedules live in
`packages/infra/queue/src/queue-names.ts:REPEATABLE_SCHEDULES`, and the worker
registers them with BullMQ at boot via `upsertJobScheduler`.

### `apps/backend/data-provider`

tRPC service that centralizes outbound 3rd-party calls. The api and worker
call it over tRPC rather than reaching for upstream APIs directly. This is
the seam between the [tiers](/scani-oss/self-hosting/tier-model/): in Tier 1
it's on `localhost:8082`, in Tier 2/3 it's a hosted endpoint.

### `apps/frontend/app`

React + Vite SPA. tRPC client end-to-end type-safe with the api.

## State

- **Postgres** — everything durable (users, holdings, transactions, balances,
  audit log)
- **Redis** — BullMQ queues + per-provider rate-limiter buckets + realtime
  fan-out
- **S3-compatible store** — binary uploads (screenshots, file imports)

## Async-job system

Single Redis-backed queue (`scani-jobs`) plus a dead-letter queue
(`scani-dlq`). The api enqueues; the worker consumes everything.

**Repeatable jobs:**

- `pricing`, `wallet-balances`, `exchange-balances` (hourly)
- `apy-payouts` (daily midnight UTC)
- `historical-price-backfill` (03:00), `forex-backfill` (03:30),
  `portfolio-value-rollup` (04:00), `transfer-linking` (05:00) — nightly chain
- `backfill-token-identity` (weekly Sunday 02:00 UTC)
- `reconcile-pending-credentials`, `reconcile-orphaned-user-jobs` (every
  minute, sweep stuck rows)

**User-initiated jobs:** `screenshot-parse`, `exchange-import`,
`wallet-import`, `file-import`, `holding-price-update`, `user-data-delete`,
`transaction-import`.

Each scheduled processor wraps in a Postgres advisory lock
(`apps/backend/worker/src/lib/cron-lock.ts`) so two overlapping fires of the
same job-name silently no-op rather than racing. Operator tooling can call
HMAC-gated job endpoints on the api (retry / remove / DLQ replay) signed with
`JOBS_HMAC_SECRET`.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) end-to-end — no Node
- **Type-check:** [`tsgo`](https://github.com/microsoft/typescript-go)
  (`@typescript/native-preview`) — 5–10× faster than `tsc` on this monorepo
- **Lint + format:** [Biome](https://biomejs.dev) (no ESLint, no Prettier)
- **HTTP:** [Elysia](https://elysiajs.com) + [tRPC](https://trpc.io)
- **Database:** PostgreSQL via [Drizzle ORM](https://orm.drizzle.team)
- **Async jobs:** [BullMQ](https://docs.bullmq.io) on Redis, with Postgres
  advisory locks for cron idempotency
- **Auth:** [Better-Auth](https://better-auth.com) (sessions in Postgres)
- **Storage:** S3-compatible via
  [`@aws-sdk/client-s3`](https://github.com/aws/aws-sdk-js-v3)
- **Email:** Fastmail JMAP API or any SMTP server
- **Frontend:** React + Vite + [Tailwind](https://tailwindcss.com) +
  [shadcn/ui](https://ui.shadcn.com)
- **Dependency injection:**
  [typedi](https://github.com/typestack/typedi) (class-field pattern — see
  [Engineering conventions](/scani-oss/contributing/conventions/))
- **Testing:** `bun test` with per-test transactional rollback for
  repository tests
