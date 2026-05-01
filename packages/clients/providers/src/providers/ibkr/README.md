# `ibkr/`

Interactive Brokers Flex Query — positions, trades, cash transactions.
The only retail brokerage we support today; Flex Query is IBKR's
"export your portfolio as XML" interface, exposed as a two-step REST
poll.

## Upstream

- Base: `https://gdcdyn.interactivebrokers.com/Universal/servlet`
- Setup docs: <https://guides.interactivebrokers.com/cp/cp.htm#am/reports/flex_queries.htm>.
- Two endpoints:
  - `POST FlexStatementService.SendRequest?t=<token>&q=<queryId>&v=3` →
    returns a `ReferenceCode` (synchronous; the report runs in IBKR's
    queue).
  - `GET FlexStatementService.GetStatement?t=<token>&q=<refCode>&v=3` →
    returns the XML report once ready (or `<Status>Warn</Status>` while
    still queued).

## Capabilities

| Capability             | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `current-balances`     | Parse `<OpenPosition>` + `<CashReportCurrency>`.         |
| `transactions`         | Parse `<Trade>` + `<CashTransaction>` rows.              |
| `credential-validator` | SendRequest probe (no GetStatement needed).              |
| `account-discoverer`   | Surfaces sub-accounts (synthetic single PORTFOLIO).      |

`canFetchTransactions(institutionCode)` returns true only for
`institutionCode === 'ibkr'`.

## Required Flex Query template

The user's Flex Query MUST include the following sections, otherwise
`fetchTransactions` and `fetchBalances` will return empty arrays:

- **Open Positions** — drives `current-balances`.
- **Cash Report** — drives `current-balances` (per-currency cash legs).
- **Trades** — drives `transactions` (buy/sell legs).
- **Cash Transactions** — drives `transactions` (dividends, interest,
  withholding tax, deposits, withdrawals, fees).

Configure in IBKR Account Management → **Reporting → Flex Queries** →
edit your activity query and tick the four sections above. Save, then
copy the Flex Query ID + Token into Scani.

The single Flex Query report covers every section we parse — Scani
fetches it once per sync and demultiplexes locally.

## Auth + env

- Per-user `flexQueryToken` + `flexQueryId` (both encrypted; user
  generates them in IBKR Account Management).
- No HMAC, no API secret — the token IS the credential.
- No env vars — Scani never holds IBKR creds.

## Rate limit + namespace

- IBKR throttles aggressively: ~1 req/s sustained, with hour-long
  blocks for repeated violations.
- Rate-limiter namespace: `ibkr` (per credential).
- Polling backoff: 10s → 20s → 30s → 45s → 60s, max 6 attempts. If
  the report isn't ready after that we throw.

## Error taxonomy

- HTTP 4xx/5xx → `Error` thrown after `fetchWithTimeout` retries.
- `<Status>Fail</Status>` in the response body → `Error` with the
  IBKR error code + message. Common codes:
  - 1019 — invalid token (auth-failed equivalent).
  - 1018 — Flex Query ID not found.
  - 1009 — token expired (Flex tokens have a 1-year TTL).
  - 1006 — no data in range.
- Polling timeout (6 attempts × max 60s ≈ 4 min total) → `Error`
  with "report not ready". Background sync retries on next cron tick.

`validateCredentials` does the SendRequest call only and short-
circuits to `{ valid: false }` on 1019 / 1018 / 1009.

## Known quirks + gotchas

- **Two-step protocol with linear backoff**. The XML report is
  asynchronous; SendRequest enqueues it, GetStatement polls until
  ready. Linear backoff (10s → 60s) over 6 attempts. Fastify
  request budget tolerates this; user-facing UI should show
  "fetching IBKR report" while it's running.
- **`flexQueryId` is per-report-template**. A user has multiple
  Flex Queries (one for trades, one for positions, one for cash
  txs) and Scani only stores ONE id. The default expectation is
  the user creates a single "Activity" Flex Query that includes
  all three sections. The setup wizard's instructions reflect
  this.
- **Token lifetime is 1 year**. IBKR doesn't auto-rotate. We
  detect 1009 in the validator and surface "regenerate token in
  IBKR" to the user; auto-rotation requires OAuth which IBKR
  hasn't shipped for retail.
- **Account discovery returns synthetic single PORTFOLIO** when
  the user has only one account. Multi-account users (advisors,
  family-office logins) get one row per `<AccountInformation>`
  entry.
- **Asset class diversity**. IBKR holds stocks, options, futures,
  forex, bonds. The transactions parser accepts the full set;
  options/futures get marked `kind: unknown` for now (we don't
  derive cost basis for derivatives — follow-up).
- **XML parsing**. Regex-based — IBKR's Flex XML is well-structured
  and the subset of nodes we extract (positions, cash balances,
  trades, cash transactions) is small enough that a full parser is
  overkill. Numeric values stay string-typed so they feed Decimal.js
  cleanly.
- **Trade asset class filter**. `<Trade>` rows can cover stocks, ETFs,
  options, futures, forex, bonds. The transactions parser maps only
  `assetCategory` ∈ {STK, ETF}; everything else is silently dropped
  (cost-basis logic for derivatives is a follow-up).
- **CashTransaction type → kind mapping**:
  - `Dividends` → `reward`
  - `Broker Interest Received` → `interest`
  - `Broker Interest Paid` / `Withholding Tax` / `Other Fees` /
    `Commission Adjustments` → `fee`
  - `Deposits` → `deposit`, `Withdrawals` → `withdraw`
  - `Deposits/Withdrawals` (combined) → sign-driven (positive →
    deposit, negative → withdraw)

## Live test (paper-trading)

IBKR exposes paper-trading accounts on the same prod URL — paper
Flex tokens work against
`https://ndcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService`
without any URL switch. The live test in `tests/providers/ibkr.test.ts`
is gated on `SCANI_LIVE=1` and reads `SCANI_TESTNET_IBKR_FLEX_TOKEN` +
`SCANI_TESTNET_IBKR_FLEX_QUERY_ID` from the environment.

## Source of truth

Concrete code: `index.ts`. XML parser config: same file.
