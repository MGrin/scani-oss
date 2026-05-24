---
title: Why no USD canonicalisation
description: Every price is stored in its native quote currency. Conversion is a graph walk at read time. This survives FX revisions and multi-currency users that USD-first schemas don't.
sidebar:
  order: 2
---

## The decision

`token_prices` stores every price in its **native quote currency** —
the currency the price was originally quoted in. A Kraken `BTC/EUR`
trade is stored with `baseTokenId = EUR`, not USD. Conversion between
any two tokens happens at read time via the
[price graph](/concepts/pricing/), walking direct → reverse direct →
one-hop via USD / USDT / EUR hubs.

There is **no** USD-canonical column anywhere in the schema.

## The alternative we rejected

A "value in USD" column on every transaction, balance, and rollup
row. Computed at write time from whatever FX rate was current. One
canonical base across the whole schema. Trivial SUM queries.

## Why we rejected it

**FX history is revised.** Central-bank reference rates are updated.
ExchangeRate-API corrects bad data points. CoinGecko refines its
historical stable-token treatment. If every trade had been stored at
its write-time FX rate, every revision would either:

- Be ignored (PnL silently drifts from reality), or
- Trigger a global rewrite of every historical row (mutating an
  [append-only ledger](/decisions/append-only-ledger/) — see the
  decision against that).

Storing trades in their *native* quote leaves the historical FX rates
in `token_prices`, where the [price graph](/concepts/pricing/) reads
them at convert time. Revising the FX history just updates the
relevant `token_prices` rows; nothing in the ledger has to move.

**Many users don't think in USD.** A EUR-based user with a
Kraken BTC/EUR holding wants their dashboard in EUR. A USD-canonical
schema forces them through two conversions (BTC → USD at trade time,
USD → EUR at read time), each with its own rounding error and each
adding noise the user did not ask for.

**Cross-listed equities have venue-native quotes.** AAPL on NYSE
quotes in USD; AAPL.L on LSE quotes in GBP. The cleanest model
records each at its native price and lets conversion choose the
target currency. (See also the
[market segment](/concepts/tokens/#the-unique-key) column that
distinguishes the two.)

**The price-graph cost is bounded and cacheable.** Direct lookups are
O(1). One-hop via three hubs is O(3). Two-hop is rarely used. The
`PriceLookup` pre-fetch optimisation reduces the hot-path rollup to
in-memory lookups. The convenience of `SELECT SUM(value_usd)` is not
worth what it costs.

## What this design unlocks

- **Lossless historical revision.** Update a `token_prices` row, and
  every read converts at the new rate. No rewrite-the-world job.
- **Multi-currency users get clean output.** EUR users see EUR; JPY
  users see JPY. No silent double-conversion.
- **The schema doesn't lie.** The stored price is the actual quote
  the upstream gave us. Forensic queries against `rawPayload` agree
  with `priceNative`.
- **New currencies are free.** Adding GBP-quoted instruments doesn't
  need a schema change; the graph just gets new edges.

## What the design costs

- **Conversion has to happen on read.** Sums over multi-currency
  positions are not a single `SUM(...)`. The
  [`PriceGraphService`](/concepts/pricing/) and
  [`PriceLookup`](/concepts/pricing/#pricelookup--the-hot-path-optimisation)
  encapsulate this cost.
- **Hub selection matters.** Pairs that don't directly trade against
  any hub will fail to resolve. In practice, USD / USDT / EUR cover
  essentially every traded asset; rare exceptions are handled by
  feeding the user's display currency into the hub list dynamically.
- **Staleness is real.** A thin pair may have no direct edge fresh
  enough to clear the [staleness cap](/concepts/pricing/#staleness-contract).
  The result is still returned with `stale=true`, and the rollup
  buckets it into [`coverageQuality='estimated'`](/concepts/rollup/#coverage-quality).

## What this rules out

- A `value_usd` column on `holding_transactions` or any other
  ledger / observation table. If you find yourself wanting one, the
  right move is to compute it through the price graph.
- A "default base currency" enum baked into application code. The
  schema treats every currency as equally first-class.

## See also

- [Pricing & the price graph](/concepts/pricing/)
- [Tokens & market segments](/concepts/tokens/)
- [Transactions (the ledger)](/concepts/transactions/)
- [Why an append-only ledger](/decisions/append-only-ledger/)
