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

The reconcilers and probes run together as one group on a quarter-hour
cadence on purpose: their database work batches into one wake, so the
database can scale to zero between runs instead of being nudged awake four
times an hour.

## Scheduled jobs

Six schedules (SC-1688). Four of them are groups: each runs its steps in
order, every step through its own advisory lock, retry, heartbeat and Sentry
name, and a step that fails, times out or finds its lock taken never stops
the steps after it. A re-attempt of the same run skips the steps that already
succeeded. The steps are listed under [Grouped steps](#grouped-steps).

| Name | Frequency | Purpose |
|---|---|---|
| `housekeeping` | Every 15 minutes, 2 past each quarter (`2-59/15 * * * *`) | Runs `dlq-depth-probe` → `job-heartbeat-probe` → `reconcile-orphaned-user-jobs` → `reconcile-pending-credentials`. Two minutes past the quarter so they do not queue behind the hourly syncs, still inside one database wake. |
| `active-pricing` | Every 15 minutes, 3 past each quarter (`3-59/15 * * * *`) | Fetch a current price, against USD, for the visible crypto of every user whose app was open in the last 20 minutes, unless it has one from the last 15 minutes. One run asks once for all of them, so the cost does not grow with the number of users. |
| `hourly` | Hourly (`0 * * * *`) | Runs `pricing` → `wallet-balances` → `exchange-balances` → `stale-sync-probe` → `payment-due-reminder`. The stale-sync probe reads the `lastSync` the two syncs just wrote. |
| `nightly` | Nightly, 00:00 UTC (`0 0 * * *`) | Runs `apy-payouts` → `exchange-transactions` → `backfill-token-identity` → `rescore-scam-tokens` → `historical-price-backfill` → `transfer-linking` → `portfolio-value-rollup` → `hide-closed-holdings` → `split-holding-probe` → `payment-horizon-roll` → `backfill-counterparty` → `engine-shadow` → `db-backup`. The order is the dependency: the rollup values holdings with the backfilled prices and reads what transfer-linking wrote, and db-backup is last so the dump is of that state. |
| `morning` | Daily, 09:00 UTC (`0 9 * * *`) | Runs `alert-sweep` → `activation-nudge`. An hour after the Monday digest, so the two letters never arrive together. |
| `weekly-digest` | Weekly, Monday 08:00 UTC (`0 8 * * 1`) | One email a week per account: base-currency net worth and its change over seven days, the biggest movers, bills due in the coming week, and anything waiting in the review queue. Every figure comes from the per-holding rows of `portfolio_value_daily`, filtered by the same inclusion rule as the dashboard total (hidden, inactive and scam-flagged holdings are left out), so the letter and the dashboard agree — which is also why it fires on Monday morning rather than Sunday night, after the nightly group's rollup. An account with no portfolio is **not** mailed, and neither is one whose newest rollup row is more than 8 days old. Every letter carries a one-click, no-login unsubscribe (`GET /e/u/:token` on the api). Needs `FRONTEND_URL` + `BACKEND_URL` on the worker; without them the job logs a refusal on every fire and sends nothing. |

## Grouped steps

Each step is a scheduled job of its own: its own lock, heartbeat and Sentry
name, and the admin's "Run now" runs it alone. It has no cron; its group owns
the schedule.

| Step | Group | Purpose |
|---|---|---|
| `dlq-depth-probe` | `housekeeping` | Sweep the dead-letter queue: alert once for each new entry, remove entries older than 14 days and failed jobs older than 30, and alert when the depth crosses a threshold. |
| `job-heartbeat-probe` | `housekeeping` | Detect jobs whose heartbeat went silent; mark them stuck. |
| `reconcile-orphaned-user-jobs` | `housekeeping` | Sweep stuck `running` user-job rows whose worker process died. |
| `reconcile-pending-credentials` | `housekeeping` | Sweep stuck `pending` integration-credential rows (UI flow interruptions). |
| `pricing` | `hourly` | Fetch a current price, against USD, for every held token a provider prices, every currency in use, the routing hubs and the FX baseline. Every run asks the providers; no stored row is reused. A stock is asked only while its exchange is open (US and Toronto, 10:00-16:00 local, weekdays) and FX only in the 23:00Z hour; every token is asked in the 23:00Z hour, and one never priced or last priced over a day ago is asked at once. |
| `wallet-balances` | `hourly` | Re-sync on-chain wallet balances across Etherscan, Helius, Bitcoin, Tron, TON. For Bitcoin, Solana and every Etherscan chain it also reads the ledger since its read-through point and writes both in one transaction, so a balance never lands without the rows that explain it (SC-1665). A user with no session in 7 days, on an account older than 7 days, is synced only in the 00, 06, 12 and 18 UTC runs; opening the app re-fetches their balances at once (`users.appOpened`). |
| `exchange-balances` | `hourly` | Re-sync exchange holdings for every connected exchange integration. For Airwallex, Kraken, Bybit, OKX, KuCoin, Bitget and IBKR it also reads the ledger since its read-through point and writes both in one transaction (SC-1665); IBKR's two reads share one Flex statement. A user with no session in 7 days, on an account older than 7 days, is synced only in the 00, 06, 12 and 18 UTC runs; opening the app re-fetches their balances at once (`users.appOpened`). |
| `stale-sync-probe` | `hourly` | Detect active, credentialed integrations that have silently stopped syncing — stale `lastSync` or zero accounts — and escalate. **Fires on ENTERING that condition, not on every probe that observes it.** `operator_alarms` holds which conditions are already open: entering escalates, recovery deletes the row and is logged rather than escalated, and a condition still true after `STALE_SYNC_RENOTIFY_MS` (7 days) is re-stated as a distinct event so it cannot go silent forever. A per-probe alarm is not merely noisy — it outnumbers every low-frequency signal the service produces and makes a once-a-day failure unreadable for as long as it lasts. Re-entry after a recovery is a fresh escalation, which is why this is a ledger rather than a rate limit or a grouping rule. |
| `payment-due-reminder` | `hourly` | One Web Push a day at ~17:00 in each user's **own** local time, summarising the payments due on their local tomorrow as a count and a per-currency total. Fires hourly and selects only the users for whom it is currently 17:00 locally — a single daily fire happens at one UTC hour, and one UTC hour is a different clock time in every zone. A user whose `users.timezone` is still NULL is SKIPPED, never defaulted to UTC, and counted in the job's log line. Nothing is sent on a day with nothing due. Needs `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`; without them the job logs a refusal on every fire and sends nothing. |
| `apy-payouts` | `nightly` | Apply accrued interest to holdings with an [APY config](/concepts/apy/) due for payout. |
| `exchange-transactions` | `nightly` | Refresh the transaction ledger for every connected exchange/broker/bank integration whose ledger is not read with its balance — fans out a `transaction-import` per account with a 30-day rolling window. A balance gap on one of those sources waits for this run (`awaiting-ledger`, at most 26 hours). |
| `backfill-token-identity` | `nightly` | Sundays only. Re-enrich tokens whose `providerMetadata` hasn't been touched lately. |
| `rescore-scam-tokens` | `nightly` | Recompute `is_scam_probability` for crypto tokens whose `scam_score_version` is stale, so a change to the scoring heuristic reaches tokens already stored. Non-crypto tokens are `unscored` and never enter the population; rows marked by a person are never recomputed. |
| `historical-price-backfill` | `nightly` | Fill price history for tokens with holdings: each missing past UTC day's close as a `daily` row at 23:59:59.999 UTC, and today's price, or a point the provider does not date to a day, as an `intraday` row at its own instant; respects `unpriceableUntil` cooldown. |
| `transfer-linking` | `nightly` | Pair CEX withdrawals with wallet deposits via `LinkTransferPairsUseCase`. |
| `portfolio-value-rollup` | `nightly` | Recompute `portfolio_value_daily` for every user at user / institution / account / holding scope. |
| `hide-closed-holdings` | `nightly` | Auto-hide holdings that have been at zero balance for the configured window. |
| `split-holding-probe` | `nightly` | Find upstream events recorded against more than one holding of the same (account, token) and escalate to Sentry. `holding_tx_dedup` is unique per *holding*, so a position split across two rows can carry the same event twice with no constraint objecting, and every per-holding reconciliation still passes (SC-239). Reads only; runs after the rollup in the nightly group, so it audits the day's settled state rather than racing it. |
| `payment-horizon-roll` | `nightly` | Advance the forward edge of every active payment's materialised schedule to twelve months out. Occurrences are generated when a payment is created, has its amount changed, or is resumed — all writes — so before this job existed an untouched payment kept whatever edge its last write gave it and lost a month of its own future every month. Near-term reads were unaffected; a year-long read tapered toward zero at a different month per payment, which reads as a book of bills ENDING rather than as missing rows (SC-622). Paused payments are skipped deliberately (their edge stops until `resume`, which fills the pause window itself), as are ended ones. Insert is `ON CONFLICT DO NOTHING` per `(payment_id, due_date)`, so a retry writes nothing twice. |
| `backfill-counterparty` | `nightly` | Extract a counterparty + description onto `holding_transactions` rows that predate the per-provider extractors. |
| `engine-shadow` | `nightly` | Foundation shadow (A1): compute every holding's balance with the new engine beside today's stored balance, now and 7 and 30 days back; then (A4) compare every visible holding's cached value (`holdings.value_base`) with the live valuation. It stores each difference with a cause category in `engine_shadow_differences`. Writes only its report tables. A failed attempt is retried, and a retry runs only the kinds no earlier attempt recorded. Removed at the flip (A5). |
| `db-backup` | `nightly` | `pg_dump --format=custom` of the whole database, uploaded to the archive bucket named by `BACKUP_BUCKET` and verified by reading the object back and comparing a sha256. Runs as the nightly group's last step, every night, whatever failed or timed out before it, so it captures a settled state rather than racing the rollup. The heartbeat probe reports to Sentry when it has not completed by 07:00 UTC. The archive is checked with `pg_restore --list` before upload: an archive that cannot be listed cannot be restored, and one that is uploaded anyway looks like protection. Needs `pg_dump`/`pg_restore` **16** in the runtime image (`apps/backend/worker/Dockerfile`) — a client older than the server refuses outright — plus `BACKUP_BUCKET` and the `S3_*` storage credentials; without them the job logs a refusal on every fire and writes nothing. |
| `alert-sweep` | `morning` | Evaluate the named alert rules and email each affected account at most once per fault. Today there is one rule, `integration-stale`: an active, credentialed integration whose accounts have not synced for `ALERT_STALE_SYNC_HOURS` (default 24), or which has never produced an account at all. Same signal as `stale-sync-probe` above, at a far looser threshold and pointed at the USER rather than at Sentry — 3h is two missed cycles and the right moment to page us, and the wrong moment to mail somebody about a blip. One letter per account however many connections it names, and it names only the ones this run claimed, never everything still broken. `alert_deliveries` is what makes that true across a BullMQ retry; a row is deleted when the integration syncs again, so a fault that recurs alerts a second time. Unverified addresses and accounts that opted out are never claimed for. Every letter carries a one-click, no-login unsubscribe (`GET /e/a/:token` on the api) that is SEPARATE from the digest's. Needs `FRONTEND_URL` + `BACKEND_URL` on the worker; without them the job logs a refusal on every fire and sends nothing. |
| `activation-nudge` | `morning` | **Off unless `ACTIVATION_NUDGE_ENABLED=1`**; every other fire logs that it skipped. One email, ever, to a verified account that signed up at least three days ago and has added no account and no holding. Each account is claimed in `users.activation_nudge_sent_at` before the send, so a retry or an overlapping fire never sends twice; a failed send gives the claim back and is counted, so the next day tries again. Written in the language the account last signed in with (`users.language`), English when none is recorded. Every letter carries a one-click, no-login unsubscribe (`GET /e/n/:token` on the api), separate from the digest's and the alerts', and links the privacy policy. Needs `FRONTEND_URL`, `BACKEND_URL` and `PRIVACY_URL` on the worker; without them the job logs a refusal and sends nothing. |

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
| `refresh-account-balance` | User triggers a manual sync | Force-refresh one account's balance, then its ledger since the read-through point, written in one transaction (SC-1665). |
| `app-open-refresh` | The app is opened or returns to the front | Work out which accounts need fresh balances and enqueue a `refresh-account-balance` for each, off the request path. |
| `manual-holdings-create` | User creates a manual holding | Insert under the manual institution; seed observation. |
| `portfolio-history-backfill` | After import / manual edit | Rebuild `portfolio_value_daily` for the affected date range for one user. |
| `currency-rate-refresh` | A read path needed a currency pair storage could not answer | Ask the provider registry for each currency against USD, off the request path; stored conversion derives the pair through USD. The figure renders without the missing rate and the next read can use the refreshed prices (SC-222). |
| `transaction-import` | (Reserved) | One-off transaction-only import flow. |
| `budget-app-import` | User imports a YNAB register, an Actual Budget export or a Mint export | Read the file again, land each mapped account's rows as one feed batch in one transaction, and pair the transfers whose two sides are both in the file. An account a provider or a wallet feeds is refused. Budgets are not imported; each row keeps its category and cleared state. History is rebuilt back to the oldest row. |
| `budget-app-import-undo` | User undoes one import | Remove the rows that upload inserted and its window, unpair transfers that lose a leg, delete the accounts it opened once they hold nothing else, and recompute each balance. |
| `user-data-delete` | User requests account / data deletion | Delete all user data per GDPR-style flow. |
| `user-backup` | User asks for a backup | Write every row the account owns, with the balance readings and decisions its figures come from, as gzipped NDJSON under `temp/backup/<userId>/`. Uploaded documents are not included yet. Supersedes the account's previous backup. |
| `user-backup-restore` | User restores an uploaded backup | Load the file into the account, which must be empty, in one transaction: every row under a new id, shared tokens matched on this instance. The engine then computes each balance from the restored evidence, and the history is rebuilt back to the oldest restored row. |

## Retry policies

Defined in `packages/business/jobs/src/retry-policies.ts`:

| Policy | Shape | Default for |
|---|---|---|
| `standard` | 5 attempts, exponential backoff, 60s base. | Most scheduled jobs. |
| `aggressive` | 10 attempts, exponential, 5s base. | Reconcilers (`reconcile-pending-credentials`, `reconcile-orphaned-user-jobs`). |
| `none` | 1 attempt. | Probes (`dlq-depth-probe`, `job-heartbeat-probe`). |
| `user-import` | 3 attempts, longer base. | User-import jobs — fail fast so the user can re-try. |

## DLQ (dead-letter queue)

Jobs that exhaust their retries land in `scani-dlq`. Nothing consumes that
queue: the `dlq-depth-probe` job alerts once for each new entry and removes it
14 days after it arrived.

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
