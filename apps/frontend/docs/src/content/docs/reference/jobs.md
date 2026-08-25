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

The reconcilers and probes all run on the same quarter-hour cadence on
purpose: aligning them means their advisory locks batch into one wake, so
the database can scale to zero between runs instead of being nudged awake
four times an hour.

## Scheduled jobs

| Name | Frequency | Purpose |
|---|---|---|
| `pricing` | Hourly (`0 * * * *`) | Refresh current prices for every token referenced by an active holding. |
| `wallet-balances` | Hourly (`0 * * * *`) | Re-sync on-chain wallet balances + transactions across Etherscan, Helius, Bitcoin, Tron, TON. |
| `exchange-balances` | Hourly (`0 * * * *`) | Re-sync exchange holdings + recent trades for every connected exchange integration. |
| `exchange-transactions` | Daily (`0 1 * * *`) | Refresh the transaction ledger for every connected exchange/broker/bank integration — fans out a `transaction-import` per account with a 30-day rolling window. |
| `apy-payouts` | Daily, 00:00 UTC (`0 0 * * *`) | Apply accrued interest to holdings with an [APY config](/concepts/apy/) due for payout. |
| `historical-price-backfill` | Nightly, 03:00 UTC (`0 3 * * *`) | Fill `daily`-granularity price history for tokens with holdings; respects `unpriceableUntil` cooldown. |
| `forex-backfill` | Nightly, 03:30 UTC (`30 3 * * *`) | Fill historical FX pairs (via Frankfurter) needed by the rollup. |
| `token-prices-downsample` | Nightly, 05:00 UTC (`0 5 * * *`) | Collapse `intraday` prices older than 7 days into one `daily` row per token/base/day (keeps the day's last reading); preserves existing `daily` and `tx-exact` rows. Caps `token_prices` growth. |
| `portfolio-value-rollup` | Nightly, 04:00 UTC (`0 4 * * *`) | Recompute `portfolio_value_daily` for every user at user / institution / account / holding scope. |
| `transfer-linking` | Nightly, 03:45 UTC (`45 3 * * *`) | Pair CEX withdrawals with wallet deposits via `LinkTransferPairsUseCase`. |
| `backfill-token-identity` | Weekly, Sunday 02:00 UTC (`0 2 * * 0`) | Re-enrich tokens whose `providerMetadata` hasn't been touched lately. |
| `backfill-counterparty` | Nightly, 05:30 UTC (`30 5 * * *`) | Extract a counterparty + description onto `holding_transactions` rows that predate the per-provider extractors. |
| `reconcile-pending-credentials` | Every 15 minutes (`*/15 * * * *`) | Sweep stuck `pending` integration-credential rows (UI flow interruptions). |
| `reconcile-orphaned-user-jobs` | Every 15 minutes (`*/15 * * * *`) | Sweep stuck `running` user-job rows whose worker process died. |
| `dlq-depth-probe` | Every 15 minutes (`*/15 * * * *`) | Read the dead-letter queue depth; emit a warn log when it crosses thresholds. |
| `job-heartbeat-probe` | Every 15 minutes (`*/15 * * * *`) | Detect jobs whose heartbeat went silent; mark them stuck. |
| `stale-sync-probe` | Hourly (`0 * * * *`) | Detect active, credentialed integrations that have silently stopped syncing — stale `lastSync` or zero accounts — and alert via Sentry. |
| `hide-closed-holdings` | Nightly, 04:30 UTC (`30 4 * * *`) | Auto-hide holdings that have been at zero balance for the configured window. |
| `split-holding-probe` | Nightly, 04:30 UTC (`30 4 * * *`) | Find upstream events recorded against more than one holding of the same (account, token) and escalate to Sentry. `holding_tx_dedup` is unique per *holding*, so a position split across two rows can carry the same event twice with no constraint objecting, and every per-holding reconciliation still passes (SC-239). Reads only; runs after the nightly chain has finished writing, so it audits the day's settled state rather than racing it. |
| `rescore-scam-tokens` | Nightly, 02:30 UTC (`30 2 * * *`) | Recompute `is_scam_probability` for crypto tokens whose `scam_score_version` is stale, so a change to the scoring heuristic reaches tokens already stored. Non-crypto tokens are `unscored` and never enter the population; rows marked by a person are never recomputed. |
| `payment-due-reminder` | Hourly (`5 * * * *`) | One Web Push a day at ~17:00 in each user's **own** local time, summarising the payments due on their local tomorrow as a count and a per-currency total. Fires hourly and selects only the users for whom it is currently 17:00 locally — a single daily fire happens at one UTC hour, and one UTC hour is a different clock time in every zone. A user whose `users.timezone` is still NULL is SKIPPED, never defaulted to UTC, and counted in the job's log line. Nothing is sent on a day with nothing due. Needs `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`; without them the job logs a refusal on every fire and sends nothing. |
| `payment-horizon-roll` | Nightly, 04:45 UTC (`45 4 * * *`) | Advance the forward edge of every active payment's materialised schedule to twelve months out. Occurrences are generated when a payment is created, has its amount changed, or is resumed — all writes — so before this job existed an untouched payment kept whatever edge its last write gave it and lost a month of its own future every month. Near-term reads were unaffected; a year-long read tapered toward zero at a different month per payment, which reads as a book of bills ENDING rather than as missing rows (SC-622). Paused payments are skipped deliberately (their edge stops until `resume`, which fills the pause window itself), as are ended ones. Insert is `ON CONFLICT DO NOTHING` per `(payment_id, due_date)`, so a retry writes nothing twice. |
| `weekly-digest` | Weekly, Monday 08:00 UTC (`0 8 * * 1`) | One email a week per account: base-currency net worth and its change over seven days, the biggest movers, bills due in the coming week, and anything waiting in the review queue. Every figure comes from `portfolio_value_daily`, so the letter and the dashboard cannot disagree — which is also why it fires on Monday morning rather than Sunday night, after the 04:00 rollup. An account with no portfolio is **not** mailed, and neither is one whose newest rollup row is more than 8 days old. Every letter carries a one-click, no-login unsubscribe (`GET /e/u/:token` on the api). Needs `FRONTEND_URL` + `BACKEND_URL` on the worker; without them the job logs a refusal on every fire and sends nothing. |

| `alert-sweep` | Daily, 09:00 UTC (`0 9 * * *`) | Evaluate the named alert rules and email each affected account at most once per fault. Today there is one rule, `integration-stale`: an active, credentialed integration whose accounts have not synced for `ALERT_STALE_SYNC_HOURS` (default 24), or which has never produced an account at all. Same signal as `stale-sync-probe` above, at a far looser threshold and pointed at the USER rather than at Sentry — 3h is two missed cycles and the right moment to page us, and the wrong moment to mail somebody about a blip. One letter per account however many connections it names, and it names only the ones this run claimed, never everything still broken. `alert_deliveries` is what makes that true across a BullMQ retry; a row is deleted when the integration syncs again, so a fault that recurs alerts a second time. Unverified addresses and accounts that opted out are never claimed for. Every letter carries a one-click, no-login unsubscribe (`GET /e/a/:token` on the api) that is SEPARATE from the digest's. Needs `FRONTEND_URL` + `BACKEND_URL` on the worker; without them the job logs a refusal on every fire and sends nothing. |
## Scheduled jobs — declared but not registered

A descriptor can exist in `packages/business/jobs/src/scheduled-jobs/`
without being listed in `SCHEDULED_JOB_DESCRIPTORS`, and then the worker
never registers it: **the jobs below do not run.** They are listed here
because the file is in the tree and a reader who finds it deserves to know
which half is missing — not because they are live. The table above is the
list of live jobs.

A descriptor belongs here only for as long as its processor is unwritten —
`payment-due-reminder` was one, and moved to the live table above when
`PaymentDueReminderProcessor` landed in the same commit that registered it
(SC-226).

**`demo-reset` is the one entry that is deliberately permanent**, and it is
the exception to the paragraph above: its processor exists and is registered,
but the worker arms the schedule only when `SCANI_DEMO_MODE=1` — and in that
case it arms *nothing else*, because every other job here damages the seeded
demo dataset. So on the deployment you are reading about it does not run, and
on a demo instance it is the only job that does.

The heading stays even when empty, because `scripts/check-docs.ts` reads both
tables and fails if either is missing — and a page that silently loses the
distinction is how a job that never runs gets read as one that does.

| Name | Frequency when registered | Blocked on | Purpose |
|---|---|---|---|
| `demo-reset` | `0 6 * * *` | Nothing — armed by `SCANI_DEMO_MODE=1`, never by the registry | Rebuilds the demo dataset from its seed, re-anchored to today. The re-anchoring is the point: the committed anchor is dated 2027 so the visual gate stays byte-stable, and against a browser clock it prints a 30-day gain that never happened over an empty bill list (SC-466). |

## User-initiated jobs

Enqueued by the api in response to a user action. They use a stable
per-user job ID so the user can see "in flight" status in the SPA.

| Name | Triggered by | Purpose |
|---|---|---|
| `screenshot-parse` | Upload a screenshot | Send to OpenAI Vision; materialise the extracted holdings under a manual institution. |
| `document-parse` | Upload an invoice | Classify the PDF, extract text (OCR only for pages that need it), then read vendor / amount / dates via the AI provider. Lands in the review feed for confirmation. |
| `exchange-import` | Connect an exchange | First-time backfill: sync balances + transactions; create accounts/holdings. |
| `wallet-import` | Add a wallet | First-time backfill: scan the address across the chain; create holdings. |
| `file-import` | Upload a CSV / file | Parse and ingest. |
| `holding-price-update` | User edits a private-token price | Persist the new price + audit row in `token_price_edit_history`. |
| `refresh-account-balance` | User triggers a manual sync | Force-refresh one account's balances + transactions. |
| `manual-holdings-create` | User creates a manual holding | Insert under the manual institution; seed observation. |
| `portfolio-history-backfill` | After import / manual edit | Rebuild `portfolio_value_daily` for the affected date range for one user. |
| `currency-rate-refresh` | A read path needed a currency pair storage could not answer | Fetch the pair off the request. The upstream call sits behind a two-per-sixty-seconds limiter whose acquire *sleeps*, so on a read path the third uncovered currency waited ~26 s; here nobody waits. The figure renders without the pair and says so, and the next read has it (SC-222). |
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
