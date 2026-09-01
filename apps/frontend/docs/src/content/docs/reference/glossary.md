---
title: Glossary
description: Financial terms used across Scani — general finance and Scani-specific. Authoritative single-page reference.
sidebar:
  order: 1
---

This is the single-page authoritative glossary. Both general
finance terms (so the rest of the docs can use them without
re-defining) and Scani-specific concepts. For each entry, an
*in Scani* line points at the relevant concept or schema where one
exists.

## Browse by topic

- [Asset & instrument](#asset--instrument)
- [Custody & venue](#custody--venue)
- [Position & ledger](#position--ledger)
- [Transactions](#transactions)
- [Pricing & FX](#pricing--fx)
- [Yield](#yield)
- [Blockchain](#blockchain)
- [**For translators**](#for-translators) — the terms whose Scani
  meaning is narrower or stranger than the dictionary's
- [Scani-specific](#scani-specific)

---

## Asset & instrument

### Asset class
A category of financial instrument with shared characteristics.
Common classes: equities, fixed income, cash & cash-equivalents,
commodities, real estate, alternatives, cryptocurrencies. Scani
tracks at the instrument level, not the asset-class level —
asset-class summaries are derived from the type of each
[token](#token).

### Bond
A debt instrument: the holder lends money in exchange for periodic
interest payments and return of principal at maturity.
*In Scani:* tracked as a [token](#token) of `type='other'`
(no native bond integration yet); priced manually or via Google
Sheets.

### Cryptocurrency
A token whose ledger is maintained on a public blockchain. Examples:
BTC, ETH, SOL, USDC.
*In Scani:* `token.type='crypto'`. Identity may include CoinGecko,
DeFiLlama, Etherscan (for ERC-20s), or Solana (for SPL tokens)
metadata.

### CUSIP
A nine-character alphanumeric identifier for North American
securities. *In Scani:* not modelled directly. The
`(symbol, type, marketSegment)` tuple identifies a security.

### Derivative
A financial contract whose value derives from an underlying asset:
options, futures, swaps. *In Scani:* not modelled directly.

### ETF
*Exchange-Traded Fund.* A basket of assets that trades as a single
listed security. *In Scani:* tracked as a regular
`type='public-stock'` [token](#token); the basket composition is
out of scope.

### Equity
A share of ownership in a company. Public equity trades on a
listed exchange; private equity does not.
*In Scani:* `token.type='public-stock'` or `'private-company'`.

### Fiat
A government-issued currency that is not backed by a physical
commodity. USD, EUR, GBP, JPY, …
*In Scani:* `token.type='fiat'`. FX rates supplied by Frankfurter
(free, no key).

### ISIN
*International Securities Identification Number.* Twelve-character
global identifier for a security. *In Scani:* not stored;
disambiguation uses [market segment](#market-segment).

### Market segment
The structural market the security trades on — NYSE/NASDAQ
(`US`), London Stock Exchange (`L`), Toronto (`TO`), etc.
AAPL on NYSE is *not* the same security as AAPL.L on LSE —
different dividends, tax treatment, and liquidity.
*In Scani:* the `marketSegment` column on `tokens`, part of the
unique key alongside `(symbol, typeId)`. Migration 0055.

### NFT
*Non-Fungible Token.* A token where each unit is distinct.
*In Scani:* not first-class. Holdings are quantitative; an NFT can
be modelled as a `type='other'` token with a balance of 1.

### Private company
A company whose shares are not publicly listed. *In Scani:*
`token.type='private-company'`; prices entered manually with an
audit trail in `token_price_edit_history`.

### Stablecoin
A cryptocurrency designed to maintain a fixed value (typically
1 USD or 1 EUR). USDC, USDT, DAI, EURC.
*In Scani:* `token.type='crypto'`; treated like any other crypto
asset, but commonly used as a hub in the
[price graph](/concepts/pricing/).

### Ticker symbol
The short alphanumeric code used to identify a tradeable asset on
a venue. `BTC`, `AAPL`, `EUR`. *In Scani:* `tokens.symbol`. Not
globally unique on its own — paired with `type` and `marketSegment`.

### Token
**Scani term of art.** Any tradeable asset — fiat, crypto, equity,
private company, or other. See [Tokens & market segments](/concepts/tokens/).

---

## Custody & venue

### Bank
A financial institution that holds fiat deposits. *In Scani:*
`institution.type='bank'`. Connect via statement import or manual
entries.

### Brokerage
A firm that executes trades in equities and other securities on
behalf of clients. *In Scani:* `institution.type='broker'`.
Native integrations: Interactive Brokers (via Flex Web Service),
Wise.

### CEX
*Centralised Exchange.* A custodial crypto exchange (Binance,
Kraken, Coinbase, …). The exchange holds the user's keys.
*In Scani:* `institution.type='crypto_exchange'`.

### Cold wallet
A wallet whose private keys are stored offline (paper, hardware,
air-gapped device). High security, low convenience. *In Scani:* no
distinction in the schema — it's just a [wallet](#wallet).

### Custodial
A venue where someone else holds your keys (an exchange, a
brokerage, a bank). *In Scani:* implicit in the institution type.

### DEX
*Decentralised Exchange.* A non-custodial trading venue executed
by smart contracts (Uniswap, dYdX). *In Scani:* trades on a DEX
appear via the on-chain transaction history of the wallet that
made them.

### Exchange
See [CEX](#cex) and [DEX](#dex).

### Hardware wallet
A dedicated device that holds private keys offline (Ledger,
Trezor). *In Scani:* no distinction — addresses you control are
[non-custodial](#non-custodial) wallets.

### Hot wallet
A wallet whose keys are stored on an internet-connected device.
*In Scani:* no distinction.

### Investment fund
A pooled vehicle managed by a fund manager. *In Scani:*
`institution.type='investment_fund'`; typically tracked manually.

### Multisig
A wallet whose transactions require multiple signatures. *In
Scani:* no first-class support; tracked as a regular wallet whose
balance is read from the multisig address.

### Non-custodial
A wallet whose private keys are held by the user. *In Scani:*
`institution.type='crypto_wallet'`.

### Omnibus account
A single account at a venue that holds the assets of many
underlying owners. Common in fund management. *In Scani:* not
modelled — Scani's tenancy is per-user.

### Self-custody
Holding your own keys. Same as [non-custodial](#non-custodial).

### Wallet
A blockchain address (or addresses) that holds tokens. *In
Scani:* `institution.type='crypto_wallet'`; the address lives in
`accounts.metadata`.

---

## Position & ledger

### Average cost
A cost-basis method: every lot has cost equal to the running
average of all acquisitions. *In Scani:* the [rollup](/concepts/rollup/)
supports FIFO by default; average-cost configurability is on the
wishlist.

### Cost basis
The amount paid for an asset, used to compute realized gain or
loss when it's sold. Cost basis is *per lot*, so the order of
sales matters (see [FIFO](#fifo) / [LIFO](#lifo) / [HIFO](#hifo)).
*In Scani:* tracked by the [rollup](/concepts/rollup/) per
holding; the `costBasis` column on `portfolio_value_daily` carries
the running total.

**"Paid" is wrong often enough to matter.** Rewards, airdrops,
interest, deposits and transfers in are booked at their
fair-market value *at receipt* — nobody paid anything. And when
nothing can value an inflow at all, the lot is opened at zero,
which is an unknown standing in for a cost rather than a purchase
that was free. How much of it is trustworthy is graded separately;
see [how much of the cost we actually know](#how-much-of-the-cost-we-actually-know).

### Double-entry
An accounting convention where every transaction has two equal
sides (a debit and a credit). *In Scani:* the ledger uses signed
quantities rather than explicit double-entry — every transaction
has *one* row with a positive or negative quantity. The "other
side" of a trade is captured via `counterTokenId` +
`counterQuantity` on the same row.

### FIFO
*First-In, First-Out.* When closing a position, consume the
oldest open lot first. *In Scani:* the rollup's default
lot-selection method.

### Gross
Before fees and expenses. *In Scani:* transactions carry separate
`feeQuantity` so gross and net can be derived.

### HIFO
*Highest-In, First-Out.* Consume the highest-cost open lot
first — minimises realized gain. *In Scani:* not yet supported;
on the wishlist.

### Holding
**Scani term of art.** One (account, token) position with a
balance. The atomic unit of portfolio tracking. See
[Holdings](/concepts/holdings/).

### Journal
A chronological record of transactions. *In Scani:* the
[`holding_transactions`](/concepts/transactions/) table.

### Ledger
The authoritative record of every event. In Scani, append-only.
See [Transactions (the ledger)](/concepts/transactions/) and
[Why an append-only ledger](/decisions/append-only-ledger/).

### LIFO
*Last-In, First-Out.* Consume the newest open lot first. *In
Scani:* not yet supported.

### Lot
A discrete acquisition of an asset at a known cost. A holding may
have many open lots; closing a position consumes lots per the
chosen method (FIFO / LIFO / HIFO).

### Mark-to-market
Valuing a position at its current market price rather than its
cost basis. *In Scani:* the dashboard headline and chart are
mark-to-market.

### Net
After fees and expenses.

### Observation
**Scani term of art.** A point-in-time snapshot of a holding's
balance from a specific source. Append-only. See
[Observations & coverage](/concepts/observations/).

### Opening balance
The starting balance of a holding when its transaction history is
incomplete. *In Scani:* synthesised by
[reconciliation](#reconciliation) as a `kind='opening_balance'`
transaction, so the ledger reconciles with the current balance.

### Position
A held quantity of an asset at a venue. *In Scani:* same as
[holding](#holding).

### Realized PnL
Gain or loss from positions that have been closed. *In Scani:*
the `realizedPnl` column on `portfolio_value_daily`.

### Reconciliation
Comparing two records and resolving discrepancies. *In Scani:*
[opening-balance reconciliation](/concepts/observations/#opening-balance-reconciliation)
synthesises a transaction to make `sum(transactions)` equal
`holdings.balance`.

### Unrealized PnL
Gain or loss on open positions, computed as
`mark-to-market value − cost basis`. *In Scani:* the
`unrealizedPnl` column on `portfolio_value_daily`.

---

## Transactions

### Airdrop
A free token distribution. *In Scani:* `kind='airdrop'`. Cost
basis typically zero.

### Buy
Acquiring an asset in exchange for another. *In Scani:* `kind='buy'`,
with `counterToken` and `counterQuantity` describing what was
paid.

### Deposit
An inflow from outside the tracked system (or from an unpaired
source). *In Scani:* `kind='deposit'`.

### Dividend
A cash distribution from a company to shareholders. *In Scani:*
tracked as `kind='reward'` or `kind='interest'` depending on
context; future iteration may add `kind='dividend'`.

### Fee
A charge by a venue for executing a transaction. *In Scani:*
`kind='fee'` (a standalone fee row) or `feeQuantity` /
`feeTokenId` on a trade row.

### Interest
Yield paid on a holding. *In Scani:* `kind='interest'`, produced
by [APY payouts](/concepts/apy/) or by ingesting upstream
interest events.

### Rebase
A protocol-driven change in token quantity (e.g. some
elastic-supply tokens). *In Scani:* not in the live `kind` set
yet; ingesters can introduce it without a migration because
`kind` is intentionally loose.

### Reward
A payout for participating (staking, mining, liquidity provision).
*In Scani:* `kind='reward'`.

### Sell
Disposing of an asset in exchange for another. *In Scani:*
`kind='sell'`.

### Settlement date
The date a trade actually settles (cash + asset change hands).
Often later than [trade date](#trade-date). *In Scani:* not
modelled — transactions use a single `occurredAt`.

### Stock split
A re-denomination of shares (2-for-1, 3-for-1, …). *In Scani:*
not yet first-class.

### Swap
A single trade that produces both an outflow and an inflow.
*In Scani:* two transactions (`kind='swap_in'` + `kind='swap_out'`)
sharing a `swapGroupId`.

### Trade date
The date a trade is executed (price agreed). *In Scani:* the
`occurredAt` on the transaction.

### Transaction
Any economic event. *In Scani:* a row in
`holding_transactions`. See [Transactions](/concepts/transactions/).

### Transfer
A move of assets between two accounts. *In Scani:* two rows
(`kind='transfer_out'` + `kind='transfer_in'`, or `'withdraw'` +
`'deposit'`) [linked](/concepts/transfers/) by `transferGroupId`.

### Withdrawal
An outflow to outside the tracked system. *In Scani:*
`kind='withdraw'`.

---

## Pricing & FX

### Base currency
The denominator in a price (`BTC/USD` → USD is the base).
*In Scani:* `tokenPrices.baseTokenId`. No USD-canonical
assumption.

### Bid / Ask
Best buy and best sell prices on an order book. *In Scani:* not
modelled at the lot level; price data is mid or close.

### Candle
An OHLC (open / high / low / close) bar at a fixed time interval.
*In Scani:* not modelled — prices are point quotes at a timestamp.

### Cross rate
A price between two non-USD currencies computed via a common
hub. *In Scani:* the [price graph](/concepts/pricing/)'s one-hop
and two-hop routing.

### FX
*Foreign Exchange.* Conversion between fiat currencies. *In
Scani:* supplied by [Frankfurter](https://frankfurter.app/) with
no key required.

### Granularity
The intended timescale of a price: `daily` (closes), `intraday`
(live), or `tx-exact` (price at a transaction's timestamp).
*In Scani:* the `granularity` column on `token_prices`.

### Mid
The midpoint between bid and ask. *In Scani:* typically what
upstream APIs return for a "current price".

### OHLC
*Open / High / Low / Close.* Standard market-data bar shape. *In
Scani:* not stored; only point quotes.

### Price graph
**Scani term of art.** The implicit directed graph defined by
`token_prices` rows. See
[Pricing & the price graph](/concepts/pricing/).

### Quote currency
Same as [base currency](#base-currency) (the denominator).

### Spot price
The current market price for immediate delivery. *In Scani:*
intraday prices are spot-equivalents.

### Stale price
A price older than the granularity-appropriate staleness cap.
*In Scani:* the `stale` flag on `PriceGraphConversion`; folded
into [coverage quality](#coverage-quality).

---

## Yield

### Accrual
The gradual accumulation of interest over time. *In Scani:* the
[APY payout](/concepts/apy/) job applies accrued interest on the
configured schedule.

### APR
*Annual Percentage Rate.* Simple-interest annual rate. *In Scani:*
not stored directly; APY is the configured rate.

### APY
*Annual Percentage Yield.* Effective annual rate accounting for
compounding within the year. *In Scani:* `holdingApyConfigs.annualRatePct`.

### Compounding
Reinvesting yield so it earns yield itself. *In Scani:*
approximated by daily payouts; longer payout frequencies undercount
compounded yield slightly.

### Liquidity provision
Supplying assets to a market-making pool in exchange for yield
(and impermanent-loss risk). *In Scani:* rewards from LP
positions land as `kind='reward'`.

### Lending
Loaning out an asset for yield. *In Scani:* tracked by manually
configuring an APY config on the relevant holding, or by
ingesting the upstream protocol's interest events.

### Staking
Locking a token to support network operations in exchange for
rewards. *In Scani:* same as lending — APY config or upstream
event ingestion.

### Yield farming
Moving assets between protocols to chase the highest yield.
*In Scani:* each leg appears as a regular transaction; no
first-class "strategy" model.

---

## Blockchain

### Block
A batch of transactions appended to a blockchain. *In Scani:* not
modelled directly; transactions reference the block via the chain
tx hash.

### Chain
A blockchain. Ethereum, Polygon, Bitcoin, Solana, Tron, TON,
etc. *In Scani:* the chain catalogue lives in
`institution_blockchain_mappings`.

### Contract address
The address of a smart contract on an EVM chain. *In Scani:*
`tokens.providerMetadata.etherscan.contractAddress`.

### ENS
*Ethereum Name Service.* Human-readable names for Ethereum
addresses (`vitalik.eth`). *In Scani:* resolved by the wallet-
discovery flow.

### EVM
*Ethereum Virtual Machine.* The execution environment shared by
Ethereum and many compatible chains (Polygon, Arbitrum, Optimism,
Base, …). *In Scani:* Etherscan V2 covers every EVM chain with
one API key.

### Gas
The fee paid to execute a transaction on a blockchain. *In
Scani:* tracked in `feeQuantity` / `feeTokenId` on transactions.

### Off-chain
Not recorded on a blockchain. *In Scani:* every CEX trade is
off-chain by definition (from the chain's perspective).

### On-chain
Recorded on a blockchain. *In Scani:* every wallet transaction is
on-chain; the source is the blockchain RPC.

### Transaction hash
The unique identifier of a blockchain transaction. *In Scani:*
used as `externalId` for on-chain transactions.

---

## For translators

Everything above defines finance. This section defines **Scani**,
and it exists because the two differ often enough to be dangerous.
A translator handed `Cost basis` or `Disposal` with no context
will produce something plausible; several of the entries below are
narrower, or stranger, than any dictionary would suggest, and
getting them wrong misstates numbers about someone's money.

Every entry carries three things: **In the UI** — the English
string as it is shown; **Means** — what this codebase actually
computes; **Where** — the surfaces it reaches. **Careful** appears
where the everyday reading is wrong.

The values in `code font` are wire values. Some of them reach the
user untranslated today (see
[Coverage quality](#coverage-quality-grades)) — they are listed so
a translator can recognise them, not so they can be translated.

### The five answers to "where did this go?"

An outflow that nothing paired to an inflow is a question the app
asks the user, because guessing it wrong invents a taxable gain
that never happened. These five are the only answers, they are
mutually exclusive, and each has a different consequence for
money. Source: `packages/business/shared/src/dtos/transfer-review.ts`.

#### Same money (`paired`)
**In the UI:** "Same money" · confirm: "Link these two"
**Means:** this outflow and that already-imported inflow are the
same movement. The [lots](#lot) carry across accounts intact
instead of being closed here and reopened at market value there.
**Where:** the transfer-review queue.
**Careful:** "pair" here is a claim of *identity* — one movement
seen twice — not a similarity or a match score.

#### Moved somewhere Scani tracks (`internal`)
**In the UI:** "Moved somewhere Scani tracks" · confirm: "Record
the move"
**Means:** the same claim as `paired`, except no inflow was ever
imported, so answering **writes** the arriving transaction.
**Where:** the transfer-review queue.
**Careful:** the destination is a *holding*, not an account — one
account can hold two positions in the same token and only the
holding says which one received it.

#### It left my portfolio (`left_control`)
**In the UI:** "It left my portfolio" · confirm: "Count it as a
disposal"
**Means:** it really did leave — sold off-platform, gifted, spent.
**This answer alone realizes a gain.** `CostBasisService` books
proceeds at market value on this value and no other.
**Where:** the transfer-review queue; the resulting row appears in
the realized ledger.
**Careful:** this is *not* a generic "transferred" or "sent". A
move between the user's own accounts is not `left_control`, and
rendering it as a neutral word for "sent out" will cause users to
book disposals they did not make.

#### Moved somewhere untracked (`untracked`)
**In the UI:** "Moved somewhere untracked" · confirm: "Record it
as still mine"
**Means:** still the user's money, in a place Scani cannot see — a
cold wallet, an exchange with no API key. **Not** a disposal;
nothing is realized.
**Where:** the transfer-review queue.
**Careful:** "untracked" describes the *destination*, not the
transaction. The money is not lost, unknown, or unrecorded.

#### Part of it was a fee (`fee`)
**In the UI:** "Part of it was a fee" · confirm: "Record it as a
fee"
**Means:** a charge taken out of what left — 500 of a 4,000
withdrawal that never reached the 3,500 which arrived. Kept by the
bank, the network or the exchange. **Not** a disposal, so nothing
is realized, and **not** money the user still holds: it is counted
as a cost, which is what makes it reduce the return figure instead
of reading as a withdrawal.
**Where:** the transfer-review queue, usually as one part of a
split; also available as a whole answer for a charge the importer
recorded as a withdrawal.
**Careful:** "fee" here is the *user's* word for the charge, not a
technical one — a bank fee, a network fee and an exchange's
withdrawal cut are all this answer. Do not translate it as
"commission" if that word implies a percentage in the target
language, and do not translate it with a word that implies a sale.

#### Split, and part
**In the UI:** "Part {{index}} of {{total}} of one {{noun}}"
**Means:** one outflow answered as more than one thing at once —
3,500 moved internally and 500 spent, or 3,500 paired and 500 a
fee. Each part carries its own answer and its own quantity in the
token's own units.
**Where:** the transfer-review queue; the realized ledger, which
groups on transaction *and* part.
**Careful:** `split` is a marker meaning "the answer is stored
elsewhere, go and read it". Nobody chooses "split" as an answer,
and it is deliberately not one of the five above.

### Where an answer came from

#### Answered by you (`user`)
**Means:** provable. The row carries a timestamp written only
inside the review queue, behind an authenticated session.

#### Answered by a rule you wrote (`rule`)
**In the UI:** "Your rule answered" · "By a rule you wrote" ·
"Answered by your rule: {{note}}"
**Means:** a standing rule the reader wrote about a *destination*
answered this transfer, and nobody looked at the transfer itself.
The answer is always `left_control`: a rule can say an address is
theirs, and nothing else (SC-380).
**Where:** the answered list in the transfer-review queue, flagged
the way a `repair` is — not because the provenance is unknown but
because the reader has not seen it — and naming the rule's own note,
which survives revoking the rule.
**Careful:** not "you said": they marked the destination, not this
transfer. Not "Scani corrected this to" either, because nothing was
corrected — nobody had answered. And not "automatic": a rule never
touches a row that already carries any source, so an answer given in
the queue can never become this one.

#### Corrected for you (`repair`)
**Means:** the answer was rewritten by a one-off repair script,
not by a person and not by an import. It exists so a corrected
answer is never mistaken for one you gave: ten own-wallet
disposals were repaired this way (SC-350), and an eleventh later
(SC-365), each because `left_control` had booked a gain on money
that had moved between two of your own wallets.
**Careful:** do not translate this as "fixed" or "automatic". It
names *who* changed the answer, not whether the answer is now
right. A repaired answer is still an answer you can change.

#### Unattributed (`unattributed`)
**Means:** only that the answer did **not** come through the
queue. It does not say who or what gave it — nearly every answered
outflow in production is one of these, inserted already-answered by an
import that no longer exists.
**Careful:** do not translate this as "imported", "automatic" or
"system". The word is deliberately weak because the data does not
support a stronger claim.

### Why a candidate was not auto-linked

Shown on each suggested inflow in the review queue, in this order.

- `ambiguous` — it matched, and so did something else.
- `quantity_outside_tolerance` — right time, wrong amount; usually
  a fee larger than the ±1% allowance.
- `time_outside_window` — right amount, too far apart; outside the
  30-minute window.
- `both_outside` — neither matched; on the list only because
  nothing better is.

### What happened to a disposal

Shown in the realized ledger. Six outcomes, because "no gain was
booked" has five different causes and they are not interchangeable.
Source: `CostBasisService`, `DisposalOutcome`.

- `realized` — proceeds were known and the gain is in the total.
  **The only outcome that adds to realized PnL.**
- `unpriced` — **In the UI:** "No price could be found for this,
  so no gain was booked. The cost is still shown." Booking zero
  proceeds would invent a loss of the entire basis.
- `unreviewed` — **In the UI:** "Waiting on your answer, so no
  gain was booked either way." The one outcome a person can clear.
- `retained` — **In the UI:** "You said this never left your
  control, so nothing was realized." The `untracked` answer.
- `awaiting_pair` — **In the UI:** "Only one side of this move was
  imported, so no gain was booked." Resolves itself when the other
  leg arrives; nothing for the user to do.
- `fee` — **In the UI:** "A charge taken out of what left, so no
  gain was booked — it is counted as a cost, not as a withdrawal."
  The `fee` answer. The distinction from `retained` is the whole
  point: `retained` says the money is still the user's somewhere,
  and this says it is gone and nobody bought anything with it.

### The words for a disposal

**In the UI:** nouns "sale", "swap", "withdrawal", "transfer",
"disposal"; verbs "Sold", "Swapped", "Withdrew", "Transferred
out", "Disposed".
**Means:** the raw transaction kind, deliberately **not** collapsed
into "sold".
**Careful:** whether a withdrawal is a sale is a question the app
asked the user. A translation that renders all five with one verb
asserts a sale nobody stated. Keep five distinct words.

### How much of the cost we actually know

**In the UI:** "Partial basis" / "No basis on record".
Source: `CostBasisService`, `CostBasisQuality`.

- `known` — complete history, every cost-relevant leg priced
  inside the freshness window.
- `partial` — **In the UI:** "Based on history we know is
  incomplete or a price outside our freshness window."
- `unknown` — **In the UI:** "We have no record of acquiring this,
  so the whole amount shows as gain."

**Careful:** these grade *confidence in the cost*, not the size of
it. `unknown` does not mean the cost was zero; it means the whole
proceeds are showing as gain because no acquisition was found. The
error only ever runs one way — upward — which is what makes it
read as good news.

### How complete a holding's history is

Source: `CostBasisService`, `HistoryCompleteness`. Three states,
not two.

- `complete` — the provider says it fetched everything.
- `incomplete` — the provider says it did **not**; a deliberate
  claim, e.g. an exchange ledger that paged out at 20,000 rows.
- `unrecorded` — nobody said either way. About a fifth of
  holdings. **Not** the same as `incomplete`, and treating it as
  such would flag more holdings than the real signal.

### Coverage quality (grades) {#coverage-quality-grades}

**In the UI:** the exported column "Coverage"; the home-screen
quality line ("All 12 holdings priced", "{{percent}}% priced").
Source: `PortfolioValuationAtTimeService`.

- `full` — at least 95% of **priceable** holdings valued, and no
  stale price and no stale anchor anywhere.
- `partial` — the same 95%, but at least one holding was valued
  from a stale price or a stale [anchor](#anchor-balance).
- `estimated` — between 50% and 95% valued.
- `unknown` — under 50%, **or** nothing in scope could ever be
  priced, so the total is zero because nothing was measured
  rather than because it is worth nothing.

**Careful, twice over.** First: holdings whose token cannot be
priced at all are removed from the *denominator*, so `full` means
"full among the ones we could price", never "everything is
covered". Second: these four words are written into the user's
CSV and XLSX exports **verbatim, in lowercase English**, so they
are user-facing strings that no translation currently reaches.

### Anchor, and stale-anchored {#anchor-balance}

**Means:** a past balance is not stored; it is reconstructed by
walking transactions from the most trustworthy known balance. The
anchor is which balance that walk started from.
Source: `BalanceAtTimeService`.

- `observation-after` — the nearest recorded balance *after* the
  date, walked backwards. Best.
- `holdings` — today's balance, walked backwards.
- `observation-before` — the nearest recorded balance *before* the
  date, walked forwards. Last resort, and the one counted as
  **stale-anchored**.

**In the UI:** the exported column "Holdings anchored to a stale
balance".
**Careful:** `anchor` here is a *reference point in time*, unrelated
to the "anchored on the day it's due" wording in recurring
payments, which is an ordinary English use of the same word. If
the target language would use one word for both, use two.

### Stale quote

**In the UI:** "{{count}} stale quotes"; the exported column
"Holdings priced from a stale quote".
**Means:** a price was found, but it is older than the freshness
window for its granularity. The value is still counted — dropping
it would fabricate a gap in the chart.
**Careful:** "stale" grades the *price*, not the holding, and not
the data being wrong.

### Unpriceable

**In the UI:** "{{fraction}} · {{count}} unpriceable".
**Means:** a token that has no price row and is inside a cooldown,
because providers have already been asked and could not supply
one. Cleared by the next successful price write.
**Careful:** it is a statement about *Scani's ability to price it*,
not about the asset being worthless or untradeable. Airdrop spam
lands here, and so does a perfectly real token no provider covers.

### Vendor

**In the UI:** "Vendors" (a top-level navigation item); "Unknown
vendor".
**Means:** who the user pays or is paid by. **Never** an
institution — AWS is a vendor; Wise, where the money moves
through, is an institution.
**Careful:** many languages share one word for "supplier",
"merchant" and "counterparty". This is specifically the other
party to a payment, not a shop and not a bank.

### Vault

**In the UI:** "Vaults" (a top-level navigation item).
**Means:** a user-defined **savings goal** with a target amount,
whose progress is the summed value of the holdings attached to it.
**Careful:** this is the single most dangerous word in the app for
a crypto-literate translator. It is *not* cold storage, *not* a
smart contract, and *not* a custody arrangement. "Savings goal" is
the meaning to translate.

### Opening balance

**In the UI:** appears as a transaction kind in history.
**Means:** a **synthesised** transaction inserted at the start of
known history so that the sum of transactions equals the current
balance. It records that history is missing, not that a real
deposit occurred.
**Careful:** not "the balance at the start of the period", which
is what the phrase means in ordinary accounting.

### APY and payout

**In the UI:** "APY", "Payout", "Last payout".
**Means:** a per-holding yield configuration the user enters, and
the interest transactions a nightly job writes from it.
**Careful:** the payout is generated from the user's own stated
rate. It is not reported by the exchange and not observed — it is
what the user said the holding earns.

### Holding, position and balance

**Means:** a **holding** is one (account, token) row — the atomic
unit. **Position** is used as an exact synonym in the code and
appears once in the UI ("add a position by hand"). A **balance**
is the *quantity* on a holding, and is never a synonym for either.
**Careful:** the epic that commissioned this glossary assumed all
three differed. Two of them do not; the third does. Translate
holding and position with the same word if the language prefers,
but never reuse that word for balance.

### Lookalike

**In the UI:** "Displays as {{impersonates}}".
**Means:** a token whose symbol is written with characters that
draw as a different, well-known symbol — Cyrillic `Ѕ` and `С`
rendering as `USDC`. Quarantined on creation.
**Careful:** this is a homograph attack, not a similar name and
not a duplicate.

---

## Scani-specific

### Account
A per-user container for [holdings](#holding) at one
[institution](#institution). See
[Accounts & institutions](/concepts/accounts/).

### Advisory lock
A Postgres-level lock that callers cooperatively acquire.
*In Scani:* used by the cron-lock wrapper to make scheduled jobs
idempotent. See
[Why BullMQ + Postgres advisory locks](/decisions/bullmq-advisory-locks/).

### BullMQ
The job-queue library Scani uses, on its **Postgres** backend.
*In Scani:* every async job runs through it. Job state lives in a
`bullmq` schema inside the same database as everything else — not
in Redis. The api is the producer; the worker is the consumer. See
[Redis](#redis) for what Redis is still for.

### Coverage
**Scani term of art.** Per-holding metadata about transaction and
observation completeness. See
[Observations & coverage](/concepts/observations/).

### Coverage quality
**Scani term of art.** A bucket on each [rollup](/concepts/rollup/)
row: `full`, `partial`, `estimated`, or `unknown`. Drives chart
rendering (solid / dashed / gap). Unpriceable holdings leave the
denominator, so `full` means "full among the ones we could price" —
see [Coverage quality (grades)](#coverage-quality-grades) for what
each value actually asserts.

### Data-provider
**Scani term of art.** The Bun service that centralises every
outbound third-party call. The seam between Tier 1 and Tier 2/3.

### Group
**Scani term of art.** A user-defined tag for organising
[holdings](#holding) and [accounts](#account). Many-to-many on
both. See [Groups](/concepts/groups/).

### Holding-inclusion rule
**Scani term of art.** The canonical predicate for whether a
holding contributes to a portfolio total
(`!isHidden && isActive && token.isScamProbability < THRESHOLD`).
Implemented in TS and SQL. See
[Why the holding-inclusion rule lives twice](/decisions/holding-inclusion-rule/).

### Institution
**Scani term of art.** A financial entity (exchange, bank,
brokerage, blockchain) under which a user has one or more
[accounts](#account). See
[Accounts & institutions](/concepts/accounts/).

### Manual institution
**Scani term of art.** A synthetic per-user institution row used
to anchor manual holdings. See
[Why manual data is a synthetic institution](/decisions/manual-institution/).

### Inclusion rule
See [holding-inclusion rule](#holding-inclusion-rule).

### Redis
Required, and **not** where the job queue lives. Since the queue
moved to Postgres, Redis carries only ephemeral state: realtime
SSE pub/sub, job-lifecycle events pushed to the UI, the api's
request rate limiter, the shared upstream-provider rate limiter,
the portfolio-value cache, and the admin HMAC replay-nonce store.
Losing it costs live updates and rate-limit windows, never a job.
The api still refuses readiness without it — `/readyz` pings it.

### Rollup
**Scani term of art.** The daily portfolio-value cache,
`portfolio_value_daily`. See
[Portfolio value rollup](/concepts/rollup/).

### Swap group
**Scani term of art.** The shared `swapGroupId` linking both legs
of a swap. See [Transfers & swaps](/concepts/transfers/).

### Tier
**Scani term of art.** One of three deployment shapes: Tier 1
(fully self-hosted), Tier 2 (semi-managed via hosted
data-provider), Tier 3 (fully managed). See
[Tier model](/self-hosting/tier-model/).

### Token identity
**Scani term of art.** The merged per-provider metadata that
materialises a token row from a partial provider-supplied
identifier. See [Token identity & enrichment](/concepts/token-identity/).

### Transfer group
**Scani term of art.** The shared `transferGroupId` linking a CEX
withdrawal to a wallet deposit (and vice versa). See
[Transfers & swaps](/concepts/transfers/).

### Vault
**Scani term of art.** A user-defined savings goal with a target
amount and currency, accumulating from percentage splits of
holdings. See [Vaults](/concepts/vaults/).
