# @scani/worker (apps/backend/worker)

BullMQ consumer. Runs every scheduled (cron) and user-initiated async job. The api enqueues; this binary processes. There is no separate cron app — repeatable schedules are registered with BullMQ at boot via `upsertJobScheduler` from descriptors in `@scani/jobs`.

## Layout

```
src/
├── index.ts                boot orchestrator (Sentry → env → container → providers → register processors → register schedules → start worker → SIGTERM)
├── config/
│   ├── env.ts              zod schema for worker-owned env (REDIS_URL, DATABASE_URL, AI_DEFAULT_PROVIDER, …)
│   └── container.ts        typedi bootstrap — imports @scani/domain barrels for side-effect @Service() registration
└── processors/             one file per BullMQ job (extends UserJobProcessor or ScheduledJobProcessor)
    ├── apy-payouts.ts                  (scheduled, daily 00:00 UTC)
    ├── backfill-token-identity.ts      (scheduled, weekly Sun 02:00 UTC)
    ├── dlq-depth-probe.ts              (scheduled, every 5 minutes)
    ├── exchange-balances.ts            (scheduled, hourly)
    ├── exchange-import.ts              (user-initiated)
    ├── exchange-transactions.ts        (scheduled, daily 01:00 UTC)
    ├── file-import.ts                  (user-initiated)
    ├── forex-backfill.ts               (scheduled, nightly 03:30 UTC)
    ├── hide-closed-holdings.ts         (scheduled, nightly 04:30 UTC)
    ├── historical-price-backfill.ts    (scheduled, nightly 03:00 UTC)
    ├── holding-price-update.ts         (user-initiated)
    ├── ingest-transactions.ts          (user-initiated; chains follow-up jobs)
    ├── job-heartbeat-probe.ts          (scheduled, every 10 minutes)
    ├── manual-holdings-create.ts       (user-initiated)
    ├── portfolio-history-backfill.ts   (user-initiated)
    ├── portfolio-value-rollup.ts       (scheduled, nightly 04:00 UTC)
    ├── pricing.ts                      (scheduled, hourly)
    ├── reconcile-orphaned-user-jobs.ts (scheduled, every minute — sweep stuck rows)
    ├── reconcile-pending-credentials.ts (scheduled, every minute)
    ├── refresh-account-balance.ts      (user-initiated)
    ├── screenshot-parse.ts             (user-initiated)
    ├── stale-sync-probe.ts             (scheduled, hourly)
    ├── transfer-linking.ts             (scheduled, nightly 03:45 UTC)
    ├── user-data-delete.ts             (user-initiated)
    ├── wallet-balances.ts              (scheduled, hourly)
    └── wallet-import.ts                (user-initiated)
```

Single source of truth for scheduled-job cron strings:
`packages/business/jobs/src/scheduled-jobs/*.ts`. User-job descriptors:
`packages/business/jobs/src/user-jobs/*.ts`. The
[`@scani/docs` jobs reference](../../../apps/frontend/docs/src/content/docs/reference/jobs.md)
mirrors this list with frequency + purpose.

## Boot flow (load-bearing)

`src/index.ts` runs in this exact order:

1. `import 'reflect-metadata'`.
2. Sentry init.
3. `loadEnv()` — fail-fast on required env.
4. `initializeContainer()` — registers `@Service()` classes from `@scani/domain`.
5. `buildProviderRegistry()` — provider registry (cloud or direct mode).
6. Wire `@scani/ingesters` callbacks: pass `Container.get(ScreenshotParsingService).parseScreenshot.bind(...)` into `ScreenshotTransactionIngester`; register both ingesters with `TransactionIngesterRegistry`.
7. **Resolve every processor class** via `Container.get(...)` — side-effect imports at the top of `index.ts` ensure typedi has them registered. The list lives in `index.ts` itself; adding a new processor means importing it here AND calling `workerClient.register()`.
8. Register the BullMQ Worker on the shared `scani-jobs` queue + the dead-letter `scani-dlq`.
9. Register repeatable schedules from `@scani/jobs/scheduled-jobs/REPEATABLE_SCHEDULES` via `JobScheduler.upsertAll()`.
10. SIGTERM/SIGINT: drain in-flight jobs, `Sentry.flush(2s)`, exit.

## Processor anatomy

Every processor extends one of two base classes from `@scani/queue`:

- **`UserJobProcessor<TPayload, TResult>`** — for jobs the api enqueues per-user. The base class handles zod-parse of payload, lifecycle pub/sub (`active` → `completed` / `failed`), error wrapping (preserving `UnrecoverableError instanceof` so BullMQ skips retries on user-actionable failures), and 32KB result-payload truncation.
- **`ScheduledJobProcessor`** — for cron jobs. The base class auto-wraps the body in `JobLock` (Postgres advisory lock keyed by `descriptor.lockName`) so two overlapping fires of the same schedule silently no-op rather than racing.

Inside a processor's `process()` body, do exactly three things:
1. Resolve the use case from typedi (`Container.get(SyncWalletBalancesUseCase)`).
2. Call `useCase.execute(payload)`.
3. Optionally enqueue a follow-up job via `Container.get(BullMqEnqueueService)` and emit a realtime entity-change event.

Domain logic does NOT live in processors. If you find yourself writing `if`-branches over domain state inside a processor, that logic belongs in a `@scani/domain` use case.

## Lock patterns

- **`JobLock`** (advisory Postgres lock) — used implicitly by `ScheduledJobProcessor` when the descriptor sets `lockName`. Prevents overlapping fires of the same cron job.
- **`RedisResourceLock`** (Redis SET-NX) — used explicitly inside `holding-price-update.ts` to debounce double-clicks on the per-holding "update price" button. Returns `{ ok: false, reason: 'lock-contention' }` rather than throwing, so the user-facing job result is honest about why nothing happened.

## Adding a new async job

1. Add a job descriptor (id, payload schema, retry policy, jobId-strategy, summarizer) in `packages/business/jobs/src/`.
2. Add the processor class here under `src/processors/`.
3. Side-effect-import the class at the top of `src/index.ts`.
4. Call `workerClient.register(Container.get(YourProcessor))` in the registration loop.
5. For scheduled jobs only: also add an entry to `REPEATABLE_SCHEDULES` in `@scani/jobs`.

## Local dev

```bash
# full stack
bun run dev:stack

# OR host-side: infra in Docker, worker in process
docker compose up -d postgres redis
bun dev:worker
```

## Deploy

Compiled to a single binary via `bun build --compile`. Runtime image is `debian:bookworm-slim` + `/app/server`. No HTTP port, no healthcheck — the container runtime observes the process's exit status; BullMQ liveness is the signal that the worker is healthy. Deploy the image to any container host.

## Tests

Most testable logic lives in `@scani/domain/use-cases` (already covered in `packages/business/domain/tests/`). Worker-local tests cover only logic that's unique to this app:

- `processors/exchange-import.test.ts` — `isUnrecoverableExchangeError` classification (which upstream errors should bypass BullMQ retry policy).

Run:

```bash
bun test apps/backend/worker --timeout 30000
```
