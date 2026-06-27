---
title: Job catalogue
description: Every scheduled (cron) job and every user-initiated job, with frequency, purpose, and where it lives in code.
sidebar:
  order: 6
---

Every async job runs through the same BullMQ queue (`scani-jobs`),
consumed by `apps/backend/worker`. Wire names live in
`packages/business/jobs/src/job-names.ts`; descriptors in
`packages/business/jobs/src/scheduled-jobs/` (for repeatable jobs)
or `packages/business/jobs/src/user-jobs/` (for user-initiated
jobs); processors in `apps/backend/worker/src/processors/`.

Scheduled jobs use the
[advisory-lock wrapper](/decisions/bullmq-advisory-locks/) — two
overlapping fires of the same name silently no-op rather than race.

## Scheduled jobs

| Name | Frequency | Purpose |
|---|---|---|
| `pricing` | Hourly (`0 * * * *`) | Refresh current prices for every token referenced by an active holding. |
| `wallet-balances` | Hourly | Re-sync on-chain wallet balances + transactions across Etherscan, Helius, Bitcoin, Tron, TON. |
| `exchange-balances` | Hourly | Re-sync exchange holdings + recent trades for every connected exchange integration. |
| `apy-payouts` | Daily, 00:00 UTC | Apply accrued interest to holdings with an [APY config](/concepts/apy/) due for payout. |
| `historical-price-backfill` | Nightly, 03:00 UTC | Fill `daily`-granularity price history for tokens with holdings; respects `unpriceableUntil` cooldown. |
| `forex-backfill` | Nightly, 03:30 UTC | Fill historical FX pairs (via Frankfurter) needed by the rollup. |
| `portfolio-value-rollup` | Nightly, 04:00 UTC | Recompute `portfolio_value_daily` for every user at user / institution / account / holding scope. |
| `transfer-linking` | Nightly, 03:45 UTC | Pair CEX withdrawals with wallet deposits via `LinkTransferPairsUseCase`. |
| `backfill-token-identity` | Weekly, Sunday 02:00 UTC | Re-enrich tokens whose `providerMetadata` hasn't been touched lately. |
| `reconcile-pending-credentials` | Every minute | Sweep stuck `pending` integration-credential rows (UI flow interruptions). |
| `reconcile-orphaned-user-jobs` | Every minute | Sweep stuck `running` user-job rows whose worker process died. |
| `dlq-depth-probe` | Every 5 minutes | Read the dead-letter queue depth; emit a warn log when it crosses thresholds. |
| `job-heartbeat-probe` | Every 10 minutes | Detect jobs whose heartbeat went silent; mark them stuck. |
| `stale-sync-probe` | Hourly (`0 * * * *`) | Detect active, credentialed integrations that have silently stopped syncing — stale `lastSync` or zero accounts — and alert via Sentry. |
| `hide-closed-holdings` | Nightly, 04:30 UTC | Auto-hide holdings that have been at zero balance for the configured window. |

## User-initiated jobs

Enqueued by the api in response to a user action. They use a stable
per-user job ID so the user can see "in flight" status in the SPA.

| Name | Triggered by | Purpose |
|---|---|---|
| `screenshot-parse` | Upload a screenshot | Send to OpenAI Vision; materialise the extracted holdings under a manual institution. |
| `exchange-import` | Connect an exchange | First-time backfill: sync balances + transactions; create accounts/holdings. |
| `wallet-import` | Add a wallet | First-time backfill: scan the address across the chain; create holdings. |
| `file-import` | Upload a CSV / file | Parse and ingest. |
| `holding-price-update` | User edits a private-token price | Persist the new price + audit row in `token_price_edit_history`. |
| `refresh-account-balance` | User triggers a manual sync | Force-refresh one account's balances + transactions. |
| `manual-holdings-create` | User creates a manual holding | Insert under the manual institution; seed observation. |
| `portfolio-history-backfill` | After import / manual edit | Rebuild `portfolio_value_daily` for the affected date range for one user. |
| `transaction-import` | (Reserved) | One-off transaction-only import flow. |
| `user-data-delete` | User requests account / data deletion | Delete (or export, depending on the flag) all user data per GDPR-style flow. |

## Retry policies

Defined in `packages/business/jobs/src/retry-policies.ts`:

| Policy | Shape | Default for |
|---|---|---|
| `standard` | 5 attempts, exponential backoff, 60s base. | Most scheduled jobs. |
| `aggressive` | 10 attempts, exponential, 5s base. | Reconcilers (`reconcile-pending-credentials`, `reconcile-orphaned-user-jobs`). |
| `none` | 1 attempt. | Probes (`dlq-depth-probe`, `job-heartbeat-probe`). |
| `user-import` | 3 attempts, longer base. | User-import jobs — fail fast so the user can re-try. |

## DLQ (dead-letter queue)

Jobs that exhaust their retries land in `scani-dlq`. The
`dlq-depth-probe` job alarms when depth grows. Operators replay
via the HMAC-gated `jobs.dlqReplay` endpoint on the api.

## Adding a job

See [Adding a scheduled job](/contributing/adding-a-job/) for the
three-place change required.

## See also

- [Why BullMQ + Postgres advisory locks](/decisions/bullmq-advisory-locks/)
- [Adding a scheduled job](/contributing/adding-a-job/)
- [Portfolio value rollup](/concepts/rollup/) — what the nightly
  chain produces.
- [Observability](/self-hosting/tier1/observability/) — which jobs
  emit log-based metrics.
