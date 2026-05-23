# @scani/jobs

Scani's async job catalog. One descriptor per business job:

- **What's the payload?** (zod schema)
- **What's the retry policy?** (BullMQ JobsOptions)
- **How do we dedup duplicates?** (deterministic jobId strategy)
- **What's safe to surface in the `/jobs` UI?** (allowlist summarizer)
- For scheduled jobs: **what's the cron pattern?** and **does it need
  a per-job-name advisory lock?**

The framework that runs these jobs lives in
[`@scani/queue`](../../infra/queue/README.md). This package speaks
its descriptor contract; the framework dispatches against it.

## Layout

```
src/
├── job-names.ts                      ← JOB_NAMES const map (wire contract)
├── user-jobs/                        ← payload schemas + descriptors
│   ├── wallet-import.ts
│   ├── exchange-import.ts
│   ├── screenshot-parse.ts
│   ├── file-import.ts
│   ├── holding-price-update.ts
│   ├── user-data-delete.ts
│   ├── transaction-import.ts
│   └── index.ts                      ← USER_JOB_DESCRIPTORS array
├── scheduled-jobs/                   ← cron + lock metadata
│   ├── pricing.ts
│   ├── wallet-balances.ts
│   ├── exchange-balances.ts
│   ├── apy-payouts.ts
│   ├── reconcile-pending-credentials.ts   (no lock — idempotent re-scan)
│   ├── reconcile-orphaned-user-jobs.ts    (no lock — idempotent re-scan)
│   ├── historical-price-backfill.ts
│   ├── forex-backfill.ts
│   ├── portfolio-value-rollup.ts
│   ├── transfer-linking.ts
│   ├── backfill-token-identity.ts
│   └── index.ts                      ← SCHEDULED_JOB_DESCRIPTORS array
└── infrastructure/                   ← bridges domain ↔ framework
    ├── user-job-enqueue-mirror.ts    ← @Service impl of EnqueueMirror
    ├── user-job-lifecycle-mirror.ts  ← @Service impl of LifecycleMirror
    └── postgres-job-lock.ts          ← @Service impl of JobLock (pg_try_advisory_lock)
```

## What's exported

| Export | Kind | Purpose |
|---|---|---|
| `JOB_NAMES` | const | Single source of truth for job-name strings |
| `WALLET_IMPORT`, `EXCHANGE_IMPORT`, `SCREENSHOT_PARSE`, `FILE_IMPORT`, `HOLDING_PRICE_UPDATE`, `USER_DATA_DELETE`, `TRANSACTION_IMPORT` | `UserJobDescriptor` consts | One per user-initiated job |
| `WalletImportJob`, `ExchangeImportJob`, `ScreenshotParseJob`, `FileImportJob`, `HoldingPriceUpdateJob`, `UserDataDeleteJob`, `TransactionImportJob` | payload types | Producer + consumer share |
| `walletImportSchema`, `exchangeImportSchema`, …  | zod schemas | Worker re-validates on receive |
| `USER_JOB_DESCRIPTORS` | readonly array | Iterate all user-initiated descriptors |
| `PRICING_SCHEDULE`, `WALLET_BALANCES_SCHEDULE`, … (11 total) | `ScheduledJobDescriptor` consts | One per cron job |
| `SCHEDULED_JOB_DESCRIPTORS` | readonly array | Iterate all scheduled descriptors |
| `UserJobEnqueueMirror`, `UserJobLifecycleMirror`, `PostgresJobLock` | `@Service()` classes | Domain-side framework hooks |

## Adding a new async job

### User-initiated (e.g. `tax-report-generate`)

1. Add the name to `src/job-names.ts`:
   ```ts
   export const JOB_NAMES = {
     // ...
     taxReportGenerate: 'tax-report-generate',
   } as const;
   ```
2. Create `src/user-jobs/tax-report-generate.ts`:
   ```ts
   import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
   import { z } from 'zod';
   import { JOB_NAMES } from '../job-names';

   export interface TaxReportGenerateJob extends UserJobBase {
     year: number;
     accountIds: string[];
   }

   export const taxReportGenerateSchema: z.ZodType<TaxReportGenerateJob> = z.object({
     userId: z.string().min(1),
     requestId: z.string().min(1),
     year: z.number().int().min(2000).max(2100),
     accountIds: z.array(z.string().uuid()).min(1).max(50),
   });

   export const TAX_REPORT_GENERATE: UserJobDescriptor<TaxReportGenerateJob> = {
     name: JOB_NAMES.taxReportGenerate,
     schema: taxReportGenerateSchema,
     defaultOpts: {
       attempts: 2,
       backoff: { type: 'exponential', delay: 30_000 },
       removeOnComplete: 100,
       removeOnFail: 500,
     },
     // Dedup: one report per (user, year, requestId). A re-run with a
     // fresh requestId gets a new id; double-click collapses.
     computeJobId: (d) =>
       [JOB_NAMES.taxReportGenerate, d.userId, d.year, d.requestId].join('_'),
     summarizePayload: (d) => ({ year: d.year, accountCount: d.accountIds.length }),
   };
   ```
3. Add it to `src/user-jobs/index.ts`:
   ```ts
   export { TAX_REPORT_GENERATE } from './tax-report-generate';
   // ...
   export const USER_JOB_DESCRIPTORS = [..., TAX_REPORT_GENERATE] as const;
   ```
4. Add a worker processor in `apps/backend/worker/src/processors/`. See
   [`@scani/queue` README](../../infra/queue/README.md#adding-a-new-async-job).

### Scheduled (cron)

Same shape — descriptor in `src/scheduled-jobs/`, processor extends
`ScheduledJobProcessor`. Set `lockName` if the job touches shared
state and two workers running in parallel would race; leave unset for
idempotent re-scans.

## Conventions for descriptors

- **Wire-contract names are immutable**: renaming a `JOB_NAMES.*`
  string is a coordinated rolling-deploy migration. The string is in
  Redis state from past enqueues + the user_jobs table.
- **`computeJobId` strategies are immutable for the same reason**:
  changing the strategy means deployed BullMQ has a different jobId
  for the same logical work, breaking dedup until both sides redeploy.
- **`summarizePayload` is an allowlist, not a denylist**: never spread
  the raw payload. Future fields might leak into the `/jobs` UI
  otherwise.
- **`defaultOpts.attempts` reflects retry-safety** — not how badly we
  want it to succeed. Idempotent jobs (transactionImport: dedup by
  external_id) get more retries (4); destructive jobs
  (userDataDelete) get one shot.

## How the framework wires the descriptors

The api's tRPC routers call
`Container.get(BullMqEnqueueService).add(WALLET_IMPORT, payload)`. The
framework reads `descriptor.schema`, `descriptor.computeJobId`,
`descriptor.defaultOpts`, `descriptor.summarizePayload` and dispatches
to BullMQ.

The worker's processor classes extend `UserJobProcessor` /
`ScheduledJobProcessor` from `@scani/queue` and set
`readonly descriptor = WALLET_IMPORT`. The base class reads the
descriptor's schema for validation and uses the descriptor's name as
the BullMQ dispatch key.

The infrastructure/ classes (`UserJobEnqueueMirror`,
`UserJobLifecycleMirror`, `PostgresJobLock`) register against the
framework's tokens (`ENQUEUE_MIRROR`, `LIFECYCLE_MIRROR`, `JOB_LOCK`)
via `@Service({ id: TOKEN })`. The framework looks them up via
`Container.get(TOKEN)` — when missing, it falls back to no-op
(useful for OSS Tier-1 deploys without a per-user job table).

## Tests

`bun test packages/business/jobs --timeout 30000`

Each descriptor file has a sibling test that asserts:

- **JobId determinism** — same payload always hashes to the same id
- **JobId variation** — different payloads (different requestId,
  different resource id) produce different ids
- **Summarizer allowlist** — only the documented fields surface; never
  `userId`, `requestId`, or any field the descriptor doesn't list
- **Schema accept/reject** — well-formed payloads parse, malformed
  ones throw
