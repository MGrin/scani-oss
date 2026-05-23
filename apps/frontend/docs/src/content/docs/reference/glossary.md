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
The amount paid for an asset, used to compute realised gain or
loss when it's sold. Cost basis is *per lot*, so the order of
sales matters (see [FIFO](#fifo) / [LIFO](#lifo) / [HIFO](#hifo)).
*In Scani:* tracked by the [rollup](/concepts/rollup/) per
holding; the `costBasis` column on `portfolio_value_daily` carries
the running total.

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
first — minimises realised gain. *In Scani:* not yet supported;
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

### Realised PnL
Gain or loss from positions that have been closed. *In Scani:*
the `realizedPnl` column on `portfolio_value_daily`.

### Reconciliation
Comparing two records and resolving discrepancies. *In Scani:*
[opening-balance reconciliation](/concepts/observations/#opening-balance-reconciliation)
synthesises a transaction to make `sum(transactions)` equal
`holdings.balance`.

### Unrealised PnL
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
The Redis-backed job-queue library Scani uses. *In Scani:* every
async job runs through it. The api is the producer; the worker is
the consumer.

### Coverage
**Scani term of art.** Per-holding metadata about transaction and
observation completeness. See
[Observations & coverage](/concepts/observations/).

### Coverage quality
**Scani term of art.** A bucket on each [rollup](/concepts/rollup/)
row: `full`, `partial`, `estimated`, or `unknown`. Drives chart
rendering (solid / dashed / gap).

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
