# Scani Implementation Plan

**Date:** April 4, 2026
**Scope:** Full codebase review findings + prioritized improvement plan
**Constraints:** All APIs must be free. Target markets: Russia, South/Southeast Asia, Singapore, Hong Kong.

---

## Current State Assessment

**What works well:**
- Clean architecture (use cases → services → repositories → DB)
- Solid auth flow (Supabase OTP)
- Good DB connection management (pools, transactions, monitoring)
- 35+ EVM chains supported via Etherscan V2
- Non-EVM: Bitcoin, Solana, TRON, TON
- Free pricing: CoinGecko, DeFiLlama, Finnhub, ExchangeRate API
- WebSocket real-time updates
- Structured logging with Pino

**What needs work:**

| Area | Grade | Key Issue |
|------|-------|-----------|
| CI/CD | D | Type-check disabled in CI |
| Testing | F | 6 test files total, zero backend tests |
| Frontend components | C | 1000+ line god components, no error boundaries |
| Exchange coverage | D | Only Binance + Kraken |
| Financial service integrations | F | No bank/broker APIs (Wise, IBKR) |
| Bank statement import | F | No file-based import at all |

---

## Phase 0: Foundation Fixes (Done)

### 0.1 CI/CD
- [x] Re-enable type-checking in `.github/workflows/type-check.yml`

### 0.2 Remove Dead Code
- [ ] Remove `react-plaid-link` from frontendV2 package.json
- [ ] Remove Plaid references from DB schema comments
- [ ] Remove unused `/reports` route comment in App.tsx
- [ ] Clean up `api-key.ts` DTO in shared package (leftover from MCP removal)

---

## Phase 1: Backend Hardening (Week 1)

### 1.1 Validation & Security
- [ ] Fix balance regex in `batch-operations.ts` — `/^-?\d+\.?\d*$/` → `/^-?\d+(\.\d+)?$/`
- [ ] Add UUID validation to all string ID inputs in routers (holdings, accounts, institutions)
- [ ] Replace `Math.random()` ID generation with `crypto.randomUUID()` (index.ts, WebSocket)
- [ ] Replace `console.error` with `logger.error` in institutions.ts
- [ ] Add base64 size limit check in screenshots router (5MB per file)

### 1.2 API Resilience
- [ ] Add retry with exponential backoff for external API calls (pricing, blockchain)
- [ ] Add circuit breaker pattern for provider outages (track failures, skip provider for N minutes)
- [ ] Add request deduplication in PricingService (cache same-token requests within 1 second)
- [ ] Increase CoinGecko rate limit from 10/min to 30/min (free tier allows it)
- [ ] Cache token search results (1 hour TTL) to reduce provider load

### 1.3 Refactor Duplicate Code
- [ ] Extract Binance/Kraken integration router logic into shared `exchangeIntegrationHandler(exchangeType)` function (~150 lines saved)

---

## Phase 2: Integrations for Target Markets (Week 2-4)

### 2.1 Wise Integration (Free, Official API)
- Auth: Personal API token (generated in Wise settings)
- Capabilities: Read balances (multi-currency), transaction history
- Free for personal use, no paid tier needed
- Implementation:
  - [ ] Create `WiseIntegration` in packages/integrations
  - [ ] Fetch multi-currency balances via `GET /v4/profiles/{profileId}/balances`
  - [ ] Map Wise balances to Scani holdings
  - [ ] Add rate limiter (Wise allows ~100 req/min)
  - [ ] Add institution seed in migration

### 2.2 Interactive Brokers (Free, Flex Queries)
- Auth: Flex Web Service token + query ID (generated in IBKR Account Management)
- Capabilities: Portfolio positions, balances, trades, dividends
- Free for all IBKR customers
- XML response format
- Implementation:
  - [ ] Create `IbkrIntegration` using Flex Query API
  - [ ] `POST /FlexStatementService/SendRequest` to request report
  - [ ] `GET /FlexStatementService/GetStatement` to fetch XML
  - [ ] Parse positions → map to Scani holdings (stocks, ETFs, options, bonds)
  - [ ] Add rate limiter (conservative: 1 req/10sec to avoid IBKR throttling)
  - [ ] Add institution seed in migration

### 2.3 Exchange Integrations (Free APIs)

Priority exchanges for target markets:

| Exchange | Region | API | Free? | Priority |
|----------|--------|-----|-------|----------|
| **Bybit** | Singapore/Asia | REST v5 | Yes | P0 |
| **OKX** | HK/Asia | REST v5 | Yes | P0 |
| **KuCoin** | Global/Asia | REST v1 | Yes | P1 |
| **Gate.io** | Asia | REST v4 | Yes | P2 |
| **MEXC** | Asia | REST v3 | Yes | P2 |

Implementation per exchange:
- [ ] Create `BybitIntegration` — spot + derivatives balances
- [ ] Create `OkxIntegration` — unified account balances
- [ ] Create `KuCoinIntegration` — spot + margin balances
- [ ] Create `GateIoIntegration` — spot balances
- [ ] Add corresponding rate limiters and integration configs
- [ ] Add exchange institution seeds in migration

### 2.4 Bank Statement File Import (New Feature)

Universal import for banks without APIs (Revolut, Russian banks, any bank).

**Supported formats (priority order):**

| Format | Coverage | Library | Priority |
|--------|----------|---------|----------|
| **CSV** | Universal (every bank exports CSV) | `papaparse` | P0 |
| **OFX/QFX** | US/Canada/EU banks, Quicken/Money | `ofx-js` | P1 |
| **MT940** | European corporate banking, SWIFT | `mt940js` | P2 |
| **1C** | Russian accounting software | Custom parser (simple text format) | P3 |

**Architecture:**
```
User uploads file → detect format → parse with appropriate parser
→ normalize to common Transaction[] format → preview in UI
→ user confirms → create holdings/update balances
```

**Implementation:**
- [ ] Create `packages/core/src/external-services/file-import/` module
- [ ] `FileFormatDetector` — detect CSV/OFX/MT940/1C by file header/extension
- [ ] `CsvStatementParser` — configurable column mapping per bank template
  - Built-in templates: Revolut, Tinkoff, Sberbank, Alfa-Bank, Wise, generic
  - User can define custom column mappings for unknown banks
- [ ] `OfxStatementParser` — parse OFX/QFX using ofx-js
- [ ] `Mt940StatementParser` — parse MT940 using mt940js
- [ ] Common `ParsedTransaction` type: date, description, amount, currency, balance
- [ ] Backend router: `fileImport.parse` (upload + preview) and `fileImport.confirm` (save)
- [ ] Frontend: new step in AddData flow — "Import from file"
  - File upload dropzone
  - Format auto-detection with manual override
  - Column mapping UI for CSV (drag-and-drop or dropdown selectors)
  - Transaction preview table with edit capability
  - Confirm and import

### 2.5 Regional Currency Support
- [ ] Ensure ExchangeRate API covers: RUB, INR, SGD, HKD, THB, VND, IDR, PHP, MYR, AED, KZT
- [ ] Add currency display formatting for non-Latin number systems
- [ ] Seed these currencies in the database if not present

---

## Phase 3: Frontend Quality (Week 3-4)

### 3.1 Critical Architecture Fixes
- [ ] Add React Error Boundary at App level with user-friendly fallback UI
- [ ] Simplify tRPC token refresh logic in `trpc-provider.tsx` — extract to `refreshToken()` utility
- [ ] Add Zod validation for URL-deserialized data in AddData flow

### 3.2 Break Up God Components
Each should be <300 lines. Extract logic to custom hooks.

- [ ] `Holdings.tsx` (1037 lines) → split into:
  - `useHoldingsFilters()` hook
  - `HoldingsTable` / `HoldingsCardView` components
  - `HoldingsBulkActions` component
  - `HoldingsToolbar` (filters, search, view toggle)

- [ ] `Accounts.tsx` (941 lines) → same pattern
- [ ] `AccountDetail.tsx` (822 lines) → extract filter/sort hook, lazy-load edit modal
- [ ] `AddData.tsx` (655 lines) → extract token creation to shared utility (DRY fix)

### 3.3 Loading & Error States
- [ ] Add skeleton loading for Holdings and Accounts pages (currently show nothing while loading)
- [ ] Add error states for failed tRPC queries (currently silent)
- [ ] Add progress steps to AddData flow ("Creating tokens..." → "Creating account..." → "Done")
- [ ] Show proper empty states when filters return no results

### 3.4 Mobile Responsiveness
- [ ] Add card view fallback for Holdings/Accounts tables on mobile (< 768px)
- [ ] Audit touch targets (minimum 44x44px per WCAG)

---

## Phase 4: Testing (Ongoing, start Week 2)

### 4.1 Backend Unit Tests (Priority)
- [ ] Repository tests — CRUD operations, edge cases
- [ ] Service tests — business logic, error paths
- [ ] Use case tests — integration flow, mocking external APIs
- [ ] Router tests — input validation, auth checks
- Target: 70%+ coverage on core package

### 4.2 Integration Tests
- [ ] Pricing provider tests (mock HTTP, verify parsing)
- [ ] Exchange integration tests (mock API responses)
- [ ] File import parser tests (test with real bank statement samples)
- [ ] Cron job tests (mock services, verify orchestration)

### 4.3 Frontend Tests
- [ ] Component tests for AddData flow (critical user journey)
- [ ] Hook tests for filter/sort logic

---

## What NOT to Build

- ~~Plaid~~ — US-only, paid, removed
- ~~Sentry~~ — removed
- ~~Mobile app features~~ — not a priority
- ~~MCP/agent system~~ — removed
- ~~Telegram bot~~ — removed
- ~~Landing page~~ — removed
- ~~Pagination~~ — dataset size doesn't warrant it
- ~~Cron scheduler~~ — handled by Render
- ~~Monitoring/alerting~~ — overkill for personal project

---

## Integration Research Notes

### Russian Banks (Tinkoff, Sberbank, Alfa-Bank)
- **No personal banking APIs available.** Russia has no Open Banking regulation.
- **Tinkoff Invest API** exists for brokerage accounts only (gRPC, free, token auth) — could add later for investment portfolio tracking.
- **Practical path:** CSV file import with per-bank templates. All Russian banks support CSV export from their apps.

### Revolut
- **No personal API.** Open Banking (AISP) requires FCA-regulated entity registration.
- **Practical path:** CSV file import. Revolut exports clean CSVs with consistent column format.

### Wise
- **Official personal API available.** Free, token-based auth, read balances + transactions.
- **Best integration candidate** — straightforward REST API.

### Interactive Brokers
- **Flex Queries API** — free for all IBKR customers. Token-based, XML reports.
- **Covers:** stocks, ETFs, options, bonds, futures, forex positions.
- **Good for:** portfolio position snapshots, not real-time trading data.

### Bank Statement File Formats
- **CSV** — universal, every bank supports it. Needs per-bank column mapping.
- **OFX/QFX** — standardized, good for US/EU banks. Library: `ofx-js`.
- **MT940** — SWIFT standard, European corporate. Library: `mt940js`.
- **1C** — Russian accounting. Simple text format, custom parser needed.
- **PDF** — fragile, AI-based parsing unreliable. Skip for now (already have screenshot parsing).

---

## Priority Summary

| Priority | What | Impact | Effort |
|----------|------|--------|--------|
| **P0** | Re-enable CI type-check (Phase 0.1) | Prevents type errors in prod | Done |
| **P0** | Dead code cleanup (Phase 0.2) | Clean codebase | 1 hour |
| **P1** | Backend validation fixes (Phase 1.1) | Security hardening | 1 day |
| **P1** | API resilience (Phase 1.2) | Reliability | 2 days |
| **P1** | Wise integration (Phase 2.1) | Multi-currency bank balances | 2 days |
| **P1** | IBKR integration (Phase 2.2) | Brokerage portfolio tracking | 2 days |
| **P1** | CSV file import (Phase 2.4) | Universal bank import | 3 days |
| **P1** | Bybit + OKX exchanges (Phase 2.3) | Asian crypto exchange coverage | 3 days |
| **P2** | Frontend error boundaries (Phase 3.1) | Prevents crashes | 1 day |
| **P2** | Break up god components (Phase 3.2) | Maintainability | 3 days |
| **P2** | Backend tests (Phase 4.1) | Confidence for refactoring | 1 week |
| **P2** | OFX/MT940 parsers (Phase 2.4) | Broader file import coverage | 2 days |
| **P3** | More exchanges: KuCoin, Gate.io (Phase 2.3) | Broader coverage | 2 days |
| **P3** | Frontend loading/error states (Phase 3.3) | Better UX | 2 days |
