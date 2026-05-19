# Codebase Review — 2026-05-19

Full review of the Scani monorepo covering security, performance,
architecture, and engineering-guideline adherence. Three areas were audited
in parallel; this document records every finding, its severity, and its
disposition. Code fixes from this review landed on branch
`claude/codebase-review-HSXA4`.

**Headline:** the codebase is well-built — strong credential crypto, SSRF
protection, consistent zod validation, tenant scoping, and HMAC-signed admin
writes. One Critical runtime bug was found and fixed; the rest are
hardening and performance improvements.

Disposition legend: **Fixed** — changed in this review. **Already mitigated**
— an existing mechanism covers it; no change. **Deferred** — real but
low-priority; left for a focused follow-up with rationale below.

---

## Critical

### C1 — DI runtime bug in three core use-cases · Fixed

`SyncExchangeBalancesUseCase`, `SyncWalletBalancesUseCase`, and
`ImportWalletAddressUseCase` used typedi constructor-param injection with
`= Container.get(...)` parameter defaults. All three are resolved via
`Container.get(...)`. Per CLAUDE.md, Bun's transpiler emits no
`design:paramtypes` metadata, so typedi passes a bogus `ContainerInstance`
into every constructor slot — the defaults never fire and every injected
field is typedi itself, throwing `x is not a function` at runtime. This
affects the hourly exchange/wallet balance syncs and wallet import.

- `packages/business/domain/src/use-cases/SyncExchangeBalancesUseCase.ts`
- `packages/business/domain/src/use-cases/SyncWalletBalancesUseCase.ts`
- `packages/business/domain/src/use-cases/ImportWalletAddressUseCase.ts`

**Fix:** converted all three to class-field DI
(`private readonly x = Container.get(X)`), matching the canonical
`HoldingService` pattern. A repo-wide scan confirmed no other offenders.

---

## High

### H1 — `await import()` outside allowed debt · Fixed
`packages/business/file-import/src/ofx-parser.ts:15` dynamically imported
`ofx-js`, violating the top-level-imports rule (allowed only in app
`index.ts` files). Hoisted to a top-level default import (`ofx-js` is
CommonJS with `module.exports.parse`), keeping the `@ts-expect-error`
justification.

### H2 — Sequential per-user loop in transfer-linking · Fixed
`apps/backend/worker/src/processors/transfer-linking.ts` processed every
user serially. Replaced with bounded-concurrency batching (25 users/batch),
preserving the per-user try/catch. Mirrors the existing pattern in
`BackfillHistoricalPricesUseCase`.

### H3 — Admin HMAC replay window · Fixed
`apps/backend/api/src/presentation/http/admin-jobs.ts` allowed a 30 s
clock-skew window for signed admin requests. Reduced `MAX_SKEW_MS` to 5 s
(`NONCE_TTL_MS` scales off it automatically). Replay protection via the
Redis nonce store is unchanged.

### H4 — Admin dev-bypass boot guard · Fixed
`apps/frontend/admin/src/lib/auth/config.ts` already threw if
`ADMIN_DEV_BYPASS=1` under `NODE_ENV=production`, but only when
`devBypassEnabled()` was first called at request time. Added an eager
module-load guard so the misconfiguration fails the deploy at boot.

### H5 — Bootstrap token hardening · Fixed
`apps/frontend/admin/src/app/auth/bootstrap/actions.ts` accepted an
`ADMIN_BOOTSTRAP_TOKEN` of ≥16 chars. Raised the minimum to 32 and added a
per-process, per-IP rate limit (6 attempts/min) on `beginBootstrapAction`
as defence-in-depth against online guessing of a weak token.

---

## Medium

### M1 — Sequential token resolution in EnrichHoldingsService · Fixed
`EnrichHoldingsService.enrich()` resolved each holding's token one DB
round-trip at a time. Token resolution is independent per holding, so it is
now pre-resolved in parallel up front; the matching loop (which has
cross-iteration index bookkeeping) still runs sequentially in-memory.

### M2 — Sequential reconciliation loop · Fixed
`OpeningBalanceReconciliationService.reconcileUser()` reconciled holdings
one at a time. Replaced with bounded-concurrency batching (10/batch) via
`Promise.allSettled`, preserving per-holding failure logging.

### M3 — Vault recalculation fan-out · Fixed
`UpdateTokenPricesUseCase` recalculated vaults per token in a sequential
loop. Replaced with bounded-concurrency batching (10/batch). (The perf
audit described this as an uncapped fan-out; it was actually fully
sequential — the fix is a speed-up, not a safety fix.)

### M4 — Reconciler error aggregation · Fixed
`reconcile-pending-credentials.ts` logged each per-row enqueue failure but
nothing summarised a systemic outage. Added a failure counter that emits a
single loud error when ≥50 % of a tick's rows fail.

### M5 — KDF cache headroom · Fixed
`packages/infra/security/src/encryption.ts` bounded the scrypt KDF LRU at
64. Production uses 64-char hex keys that skip scrypt entirely, so this
only affects dev/test, but a large dev import with per-record salts could
thrash. Raised the cap to 256 and documented that the path is non-prod.

### M6 — `LOG_ID_PEPPER` documentation · Fixed
Added an explicit warning to `.env.example` that with `LOG_ID_PEPPER`
unset, user/tenant/account IDs appear in plaintext in dev/test/local logs,
and that CI/staging/prod must always set a pepper.

### M7 — Inline test files migrated · Fixed
14 `*.test.ts` files sat next to source inside `src/`. Migrated to the
mirrored `tests/` layout (`packages/business/shared`, `packages/infra/queue`,
`apps/backend/data-provider`) with corrected relative imports. Two of the
14 (`dtos/batch`, `dtos/holding`) were stale duplicates of already-correct
`tests/` copies and were deleted.

### M8 — Resource locks on balance sync · Already mitigated
The perf audit suggested per-`(userId, institutionId)` resource locks to
prevent double-writes. Both `EXCHANGE_BALANCES_SCHEDULE` and
`WALLET_BALANCES_SCHEDULE` set `lockName`, so `ScheduledJobProcessor`
already serializes concurrent runs via a Postgres advisory lock, and each
run processes all accounts in one pass. There is no user-initiated
balance-sync job that could race. No change made.

### M9 — Missing index on credentials lookup · Already mitigated
The perf audit flagged a potential seq-scan on
`user_integration_credentials.institution_id`. A dedicated index
(`idx_user_integration_credentials_institution_id`) already exists in
`packages/infra/db/src/schema/user-integration-credentials.ts`. No change
needed.

### M10 — Unbounded `findAllActive()` · Not an issue
`InstitutionBlockchainMappingRepository.findAllActive()` loads the whole
table, but `institution_blockchain_mappings` is a small fixed catalog
(~24 chains), not user data. Pagination would be over-engineering. No
change made.

### M11 — Cross-import pricing cache · Deferred (investigated, no clear gap)
The perf audit speculated about redundant upstream price fetches across
imports. `PriceWarmupService` already persists prices to the DB, and the
data-provider / `clients/providers` layers carry rate limiters and
per-provider circuit breakers. No concrete redundant-fetch path was found;
adding a speculative worker-window cache risks staleness bugs. Left for a
measured follow-up if profiling shows a real hot path.

---

## Low

### L1 — Admin session cookie `SameSite` · Fixed
`apps/frontend/admin/src/lib/auth/session.ts` used `sameSite: 'lax'`.
Tightened to `'strict'` — the admin console is single-tenant, passkey-gated,
and never reached via a cross-site link.

### L2 — Circuit breaker on historical-price backfill · Deferred
`HistoricalPriceBackfillService` falls back to per-day provider calls with
no circuit breaker, so a flaky provider can be retried many times in one
nightly run. The job is scheduled, locked, idempotent, and bounded by the
needed-days set, so the blast radius is small. A breaker belongs in a
focused change (correct failure threshold / half-open timing / per-provider
keying) with its own tests rather than a drive-by edit to a pricing-critical
path.

### L3 — Email open-tracking pixel rate limit · Deferred
The HMAC-signed open-tracking pixel has no per-recipient rate limit, so
open counts can be inflated by mail-client prefetch or reloads. This is a
data-quality nicety, not a security issue (the token is tamper-proof). The
right dedupe window is a product decision; left for a follow-up.

### L4 — Docker-compose dev secrets · Accepted
`docker-compose.yml` inlines obvious dev placeholders
(`dev_..._not_prod_safe`, `change_me`). They are self-evidently fake and
prod secrets come from Fly/Terraform, not the compose file. Moving them to
a `.env` risks breaking `bun dev:stack` for no real security gain. No
change made.

### L5 — Admin audit `actor` truncation · Not an issue
`admin-write.ts` builds `actor` from the first 12 chars of the credential
ID. The audit suggested collision risk, but the admin app uses a single
shared passkey — there is exactly one credential ID — so there is nothing
to collide. The `iat` suffix already disambiguates logins. No change made.

### L6 — Per-processor queue concurrency · Documentation only
`WorkerClient` defaults processor concurrency to 1. This is correct for
scheduled jobs; user-initiated processors could be tuned higher. No code
change — recommended as a future tuning pass with per-job env overrides.

---

## Positive findings

- **Credential encryption** — AES-256-GCM with authenticated tags,
  per-record salts, scrypt KDF with a bounded cache, and a hard refusal to
  run the plaintext path in production.
- **SSRF** — `fetchHtmlBounded` resolves DNS and blocks private / loopback /
  metadata ranges with timeouts.
- **Admin writes** — canonical-string HMAC with `timingSafeEqual`,
  timestamp skew check, and a Redis-backed replay nonce store.
- **Input validation** — tRPC inputs are zod-validated; file uploads
  enforce content-type + extension whitelists; storage keys are scoped to
  the user.
- **Tenant isolation** — user-scoped reads consistently filter by `userId`
  (`findByIdAndUser` etc.).
- **Dependency hygiene** — `syncpack` and `knip` both pass; type-check is
  uniformly `tsgo --noEmit`; no `npm`/`yarn` usage; suppression comments
  carry justifications.

## Verification

`bun run type-check` (27 workspaces), `bun lint:fix`, `bun run deps:lint`,
and `bun run deps:unused` all pass. `bun test` passes for every package not
requiring Postgres (383 tests across the changed non-DB packages, plus the
371 migrated tests). DB-backed suites were not runnable in the review
environment (no Docker); CI runs them against a Postgres service container.
