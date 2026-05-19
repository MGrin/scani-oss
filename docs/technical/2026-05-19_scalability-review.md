# Scalability Review — 2026-05-19

Focused review of whether Scani performs well at 100–1000 users each holding
a mid-to-large data amount (hundreds to low-thousands of holdings /
transactions / price rows per user). Three parallel audits covered the
database, the background-job/worker layer, and the API/realtime/frontend
layer; every finding below was hand-verified before action.

**Headline:** the main genuine scale risk was the **background-job layer** —
several scheduled jobs walked every user / token / config strictly one at a
time and would not have finished inside their cron windows at 1000 users.
Those are fixed. The database layer is in good shape (userId-scoped queries,
correct indexes). Several audit findings did not survive verification — they
were based on imagined global queries or arithmetic errors — and are recorded
below as non-issues so the next reviewer doesn't re-chase them.

Disposition: **Fixed** — changed this pass. **Not an issue** — verified, no
change needed. **Deferred** — real but needs a runnable env (DB / Redis /
browser) to implement and validate safely; implementation guidance included.

---

## Fixed

### Worker throughput & job concurrency

- **`WORKER_CONCURRENCY` 2 → 8** (`apps/backend/worker/fly.toml`). The single
  worker machine had only 2 job slots, so user-initiated imports queued
  behind the hourly cron tide. `cronConcurrency` auto-derives to `ceil(8/2)=4`
  (`apps/backend/worker/src/index.ts:253`), reserving 4 slots for user jobs.
- **Parallelized sequential per-user / per-row job loops** with bounded
  concurrency (the established chunked-`Promise.all` pattern). These loops
  scaled linearly with user/data count and were the real cron-window risk:
  - `RollupPortfolioValueDailyUseCase` — per-user loop (concurrency 8). Each
    user is independently prefetch-scoped and per-user-advisory-locked.
  - `ApplyApyPayoutsUseCase` — per-APY-config loop (concurrency 10).
  - `SyncExchangeBalancesUseCase` — per-credential (per-user) loop within
    each institution (concurrency 8).
  - `SyncWalletBalancesUseCase` — per-user loop (concurrency 8).
  - `forex-backfill` — the 56 sequential (day × hub-currency) calls
    (concurrency 6).
  - `backfill-token-identity` — the per-token loop (concurrency 8).

### Database

- **`statement_timeout` for API connections** (`packages/infra/db/src/connection.ts`).
  Previously only cron jobs set one. A runaway query under load could pin a
  pool slot indefinitely. Now 30 s for normal connections, 120 s for cron.

### API read path

- **Group-allocation N+1** (`AssetAllocationService.calculateGroupAllocation`).
  It issued `getHoldingsByGroupId` + `getAccountsByGroupId` once per group
  (2N sequential queries) and scanned the whole holdings array with
  `.find()` / `.filter()` inside nested loops. Added batch repository methods
  (`GroupRepository.getHoldingsByGroupIds` / `getAccountsByGroupIds`) so it
  runs two queries total, and indexed holdings by id and by account for O(1)
  lookups.

---

## Not an issue (verified)

- **Missing indexes.** The DB audit proposed indexes for transaction-list
  `kind` filtering, a token scam-probability join, and the admin audit log.
  Verified against the actual queries: `HoldingTransactionRepository.findByRange`
  always filters by `userId` and is served by `idx_holding_tx_user_occurred`;
  secondary `kind`/`source` filters apply within one user's (bounded)
  transaction set. The holdings↔tokens join is a primary-key join. The admin
  audit log is a few-thousand-row table. The audit's row-count estimates
  assumed cross-user global queries that do not exist. No indexes added —
  unused indexes only cost write overhead.
- **Append-only table retention.** `job_heartbeats` is PK-upserted (one row
  per job, bounded). `admin_audit_log` is tiny. Only `credential_pool_borrow_log`
  grows unbounded — and it has *no read paths* (schema comment), so its
  growth degrades no query, only storage (~hundreds of MB/year). A dedicated
  retention job is premature infrastructure; the natural time to add it is
  when borrow-stats read paths are built. Recorded as a known growth item.
- **Realtime per-user fan-out.** `UpdateTokenPricesUseCase` emits one event
  per affected user in a loop. `emitEntityChange` is fire-and-forget (it does
  not await the Redis publish) and `emitBulkEntityChanges` is itself
  per-user — so the loop is microseconds of CPU plus background publishes
  once an hour. Not a bottleneck.
- **`RollupPortfolioValueDailyUseCase` memory / N+1.** Already deliberately
  prefetch-optimized (3 bulk queries replace ~350k per-(holding,day) reads)
  and user-paged. The audit's "2–4 hour / OOM" estimate was wrong; the only
  real gain was making the per-user loop concurrent (done above).

---

## Deferred — needs a runnable environment

These are genuine but were not shipped this pass: each needs a DB / Redis /
browser to implement and validate, and shipping them blind risks regressions
(stale financial data, broken table layout). Implementation guidance:

- **Redis cross-request cache for the holdings join.** The 7-table
  `HoldingRepository.findByUserWithFullDetails` recomputes per request;
  `request-cache.ts` dedups only within one tRPC batch. Lower-priority than
  it first appears — the query is an indexed, userId-scoped join — but a
  short-TTL (15–30 s) Redis cache keyed `holdings:full:{userId}:{includeHidden}`
  would cut repeated dashboard/holdings polls. **Must** serialize with
  `superjson` (the result contains `Date` columns) and invalidate on every
  holding / account / transaction mutation. Needs Redis + Postgres to
  validate the invalidation surface end-to-end.
- **Frontend list virtualization.** `DataViewTable` / `DataViewCards`
  (`apps/frontend/app/src/v2/components/data-view/`) render every row. At
  low-thousands of holdings this is slow. Add `@tanstack/react-virtual`
  (same ecosystem as the already-used `@tanstack/react-query`). Virtualizing
  the semantic `<table>` needs spacer-row or absolute-positioning techniques
  whose scroll/layout correctness must be checked in a browser — out of
  scope for a headless change.
- **Holdings list pagination.** `holdings.getWithDetails` returns all
  holdings unbounded. Note: the holdings page does client-side sort/filter
  across the full set, so naive API pagination would break that UX —
  frontend virtualization (above) is the better fix for the same scale
  concern. Pagination only makes sense paired with server-side sort/filter.

---

## Known limits (no change)

- **Single-machine WebSocket state.** `WebSocketRealtimeUpdatesService` keeps
  `userConnections` in memory, so a deploy drops all connections and clients
  reconnect. Adequate for 100–1000 users on one machine; horizontal WS
  routing (Redis-tracked connections, graceful drain) is a separate project.
- **Pricing job fault-isolation.** The hourly pricing job fetches all tokens
  in one pass; an upstream provider failure can fail the whole run. Partial
  tolerance (price 95 %, log the rest) is a worthwhile follow-up.
- **`credential_pool_borrow_log` growth.** ~hundreds of MB/year; harmless
  until borrow-stats reads exist, then add retention alongside them.

## Verification

`bun run type-check` (27 workspaces), `bun lint:fix`, `bun run deps:lint`,
`bun run deps:unused` all pass. Non-DB test suites pass. DB-backed suites and
the frontend dev server were not runnable in the review environment (no
Docker / browser) — CI exercises the DB suites. The job-loop concurrency
changes preserve the existing per-unit advisory locking and error handling.
