# `ibkr/`

Interactive Brokers Flex Query — positions, trades, cash transactions.
The only retail brokerage we support today; Flex Query is IBKR's
"export your portfolio as XML" interface, exposed as a two-step REST
poll.

## Upstream

- Base: `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService`
  (SendRequest); GetStatement runs against whatever `<Url>` the SendRequest
  response carries, typically `https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService`.
- Setup docs: <https://guides.interactivebrokers.com/cp/cp.htm#am/reports/flex_queries.htm>.
- Two endpoints (both **GET** with query-string params, v=3):
  - `GET .../FlexWebService/SendRequest?t=<token>&q=<queryId>&v=3` →
    returns `<Status>Success</Status>` + a `<ReferenceCode>` and a
    `<Url>` for GetStatement (synchronous; the report runs in IBKR's
    queue).
  - `GET <Url>?t=<token>&q=<refCode>&v=3` → returns the XML report once
    ready, or a `<FlexStatementResponse>` with error code `1019`/`1001`
    while still queued.

Note: the legacy `Universal/servlet/FlexStatementService.{SendRequest,GetStatement}`
endpoints over POST silently return error code `1001` even on
token+query pairs whose templates run successfully in Account Management.
Don't use them.

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

### When a section is missing (SC-435)

The section list belongs to the user's saved query, not to us, so a
query without "Cash Transactions" returns a statement that parses
perfectly and never contains a dividend, interest payment, deposit or
withdrawal. Until SC-435 that was indistinguishable from an account
***REMOVED***
***REMOVED***

`statement-warnings.ts` checks the **container** element — `<CashTransactions>`,
not `<CashTransaction>` — because that is what a *selected* section
produces. Its absence is about the query; its presence with no rows
inside is about the account, and that case stays silent.

- `fetchTransactions` reports a missing `Trades` or `CashTransactions`
  section through `ctx.noteWarning` (SC-428), which renders verbatim in
  the import job's result.
- `runFlexQuery` logs all four sections and the statement's size on
  **every** fetch (`IBKR statement: sections present`), whether or not
  anything is missing — a line that only appears when something is
  wrong cannot distinguish "nothing wrong" from "never ran".

`fetchBalances` gets no warning, only the log: the balance context has
no warning channel, just the per-snapshot `asOfNote` (SC-384).

### When a cash row arrives and we cannot place it (SC-435)

The other door to the same symptom. `classifyCashType` matches IBKR's
`type` attribute **exactly**, so a category we never knew about — or one
IBKR renames — silently drops real money out of the ledger, and from the
reader's side that is indistinguishable from a section we never got.

`fetchTransactions` counts those rows and reports them through
`ctx.noteWarning`, naming each type verbatim: the string is what has to
be added to the map, so a user who forwards the warning has forwarded
the whole bug report. Unlike the missing-section warning it does **not**
send them to IBKR — there is nothing for them to change, and telling
them to check a setting that is already correct is worse than silence.

`BASE_SUMMARY` rows are IBKR's own total line and are dropped on
purpose; they never count as unmapped.

## Auth + env

- Per-user `flexQueryToken` + `flexQueryId` (both encrypted; user
  generates them in IBKR Account Management).
- No HMAC, no API secret — the token IS the credential.
- No env vars — Scani never holds IBKR creds.

## Rate limit + namespace

- Rate-limiter namespace: `ibkr-flex`, per credential, 1 request per 5s
  (`ibkrFactory`). Deliberately below the ~1 req/15s at which 1018 fires, so
  a user can validate and then sync without tripping it.
- Each HTTP call has a 60s timeout (`FLEX_REQUEST_TIMEOUT_MS`); SendRequest
  can hang for tens of seconds when a previous report has not cleared
  server-side.
- **Polling is a fixed delay, not a backoff.** SendRequest retries 6 times at
  8s; GetStatement polls 24 times at 12s, ~5 minutes of patience, because a
  heavy template can take several minutes to generate. BullMQ auto-extends
  its 30s lock at `lockDuration/2` while the handler is alive, so a
  multi-minute poll does not trigger stalled-job recovery.
- **Exhausting the poll is `retryable` (SC-443).** Running out of budget is
  our clock expiring, not IBKR refusing us: the report was accepted and had
  not been built yet. Both loops raise a `ProviderError` of kind `retryable`
  carrying `IBKR SendRequest still transient after 6 retries` or `IBKR report
  still generating after 24 retries`, and neither sets `retryAfterMs` —
  scheduling the next attempt is the caller's job. Network/timeout failures
  behave the same way by a different route: the last one rethrows the
  underlying plain `Error`, which callers also treat as retryable.
- **Nothing retries forever.** The budget above is spent inside one attempt;
  the attempt count belongs to the job descriptor in `@scani/jobs`.
  `exchange-import` gets `RETRY_EXTERNAL` (3 attempts, 10s exponential),
  `transaction-import` allows 4 at 15s, `refresh-account-balance` 2 at 5s, and
  the hourly `exchange-balances` cron has no BullMQ retry at all — its retry
  is the next hour. Once those run out the job is `retries_exhausted`, which
  the user reads as "this was tried 3 times and failed every time", with a
  re-run offered and a row in the review feed.

## Error taxonomy

`classifyFlexError()` in `index.ts` is the whole of it: every
`<Status>Fail</Status>` body, from either endpoint, is turned into a
`ProviderError` by that function. Read it there — this table is a summary of
it, and where the two disagree the function is right.

| Code | `kind` | `retryAfterMs` | Why |
|---|---|---|---|
| `1025` | `rate-limited` | **24 hours** | Lockout, not throughput. See below. |
| `1018` | `rate-limited` | 60s | Ordinary throughput limit; clears on its own. |
| `1010`, `1012` | `auth-failed` | none | Time does not fix a bad token — it needs the user, and a window would only postpone telling them. |
| anything else | `unrecoverable` | none | Deliberate: an unmapped code is not silently retried. |

`1001` and `1019` never reach `classifyFlexError` at all. Both poll loops own
them end to end: `TRANSIENT_GENERATION_ERROR_CODES` retries them with a delay,
and the attempt that runs out of budget raises `flexPollExhausted` rather than
falling through. So the `anything else` row means what it says — a code this
provider has never been asked to rank — and cannot quietly absorb a code that
merely took too long.

Until SC-443 it did absorb exactly that, and the fall-through landed on
`unrecoverable`, which renders to the user as "this failed for a reason
another attempt will not fix. Check the details below, correct them, and start
it again". There is nothing in a slow report to correct. The reversal is
argued at `flexPollExhausted` in `index.ts`; the short version is that the
counter-argument — that surviving five minutes of polling proves the template
is too heavy — asserts a cause the code cannot observe, and production has
never produced one instance of it (measured 2026-08-19: no `user_jobs` row in
three months carries any Flex code, and the single live credential has
`sync_failure_count = 0`).

**1025 is the one that matters, and it is not an ordinary rate limit (SC-279).**
IBKR returns it after repeated failure and keeps returning it; each further
attempt is another failed attempt against the counter that has to age out.
Retrying is not recovery, it is the mechanism that *sustains* the lockout. The
window must be honoured by not calling at all, not by sleeping and retrying —
an hourly schedule retried one hourly, for 57 Sentry events. The 24 hours is
chosen to be obviously safe rather than accurate: IBKR does not document the
cooldown, and waiting too long costs one more day of staleness that is already
flagged in the account row, while waiting too little costs a lockout that
never ages out. The reasoning is argued in full at `IBKR_LOCKOUT_MS`.

HTTP 4xx/5xx from either endpoint throws `ProviderError.fromHttp` before any
code classification, so a 503 from the Flex service is `retryable` and a
401 is `auth-failed` — the status is the only evidence available at that
point, and it is enough to keep an outage out of the `unrecoverable` bucket.

`validateCredentials` returns `{ valid: false }` for IBKR's bad-token codes
(1010, 1012) and for its own shape checks — a wrong `institutionCode`, a
missing `flexQueryToken` / `flexQueryId`. **Everything else it re-throws**
(SC-445). It used to answer `{ valid: false, message }` on any throw at all,
which reported a 24-hour lockout, a throughput limit, a report IBKR had not
finished generating and a network failure as an invalid credential — and the
reasonable response to that is to go regenerate the token, which on 1025 is
the mechanism that sustains the lockout. `credentialRejection` in
`core/errors.ts` is the catch that draws the line; the api turns the re-thrown
`kind` into "we could not check right now".

**Nothing user-facing runs through it today.** `ibkrManifest` sets
`skipServerValidation`, so `integrations.validateKeys` stores the credential
and enqueues the import without calling any validator — one SendRequest per
minute is the whole budget and the worker needs it. What a user sees after
connecting IBKR is the import job's own outcome, which is SC-443's subject.
The fix above is for the day that flag flips, and for the contract every other
credentialed provider now shares.

Pinned by `packages/clients/providers/tests/providers/ibkr.test.ts`
("IbkrProvider — Flex error classification").

## Freshness — the statement is a day behind, by design (SC-384)

The Flex Web Service is a **reporting** interface. IBKR generates an activity
statement after the close and serves that same statement all day, so a sync at
15:10Z returns the previous business day's closing positions. That is not a
bug and it is not fixable from here: IBKR's Client Portal Web API does return
same-day positions, but it authenticates by OAuth 1.0a signature or a gateway
session and a Flex token can produce neither — measured, every Client Portal
endpoint answers 401 to one and ignores the `t=` parameter entirely. See
`docs/technical/2026-08-19_sc384-ibkr-flex-lag-is-inherent.md`.

So `fetchBalances` reports the date the statement claims rather than the clock:

- `capturedAt` ← `<OpenPosition>` / `<CashReportCurrency>` `reportDate`, then
  `<FlexStatement toDate>`, then (only if IBKR sends neither) `new Date()`.
- **Never `whenGenerated`** — that is when IBKR built the report, which for an
  intraday fetch is today even when the data in it is not.
- Both date spellings parse (`20260817`, `2026-08-17`); the format is a
  per-query setting the user picks and we do not set it for them.
- `asOfNote` carries the one-sentence reason, so the date never reaches a
  reader bare. The sync writes both to `accounts.metadata.balancesAsOf`,
  beside `lastSync` rather than over it.

## Known quirks + gotchas

- **Two-step protocol, and it is slow**. The XML report is asynchronous;
  SendRequest enqueues it, GetStatement polls until ready at a fixed 12s
  across up to 24 attempts. A user-initiated sync can therefore sit for
  minutes; the provider reports progress through `onStatus` ("Waiting for
  IBKR — generating report (attempt n/24)…") and the UI should show it.
- **`flexQueryId` is per-report-template**. A user has multiple
  Flex Queries (one for trades, one for positions, one for cash
  txs) and Scani only stores ONE id. The default expectation is
  the user creates a single "Activity" Flex Query that includes
  all four sections. The setup wizard's instructions reflect
  this.
- **Token lifetime is 1 year**. IBKR doesn't auto-rotate, and nothing here
  detects an expiry code specifically — an expired token surfaces as whatever
  `classifyFlexError` makes of the code IBKR returns, with the raw IBKR
  message attached. Auto-rotation would need OAuth, which IBKR hasn't shipped
  for retail.
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
`https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService`
without any URL switch. The live test in `tests/providers/ibkr.test.ts`
is gated on `SCANI_LIVE=1` and reads `SCANI_TESTNET_IBKR_FLEX_TOKEN` +
`SCANI_TESTNET_IBKR_FLEX_QUERY_ID` from the environment.

## Source of truth

Concrete code: `index.ts`. XML parser config: same file.
