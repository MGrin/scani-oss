---
title: Mental model
description: The one-page overview of how Scani's data model is wired — ledger, holdings, observations, prices, rollup.
sidebar:
  order: 1
---

## Summary

Scani tracks a portfolio as **two concurrent records of truth**: an
append-only ledger of every economic event, and an append-only log of
observed balances at points in time. Current state ([holdings](/concepts/holdings/))
is a denormalised cache. Past state is reconstructed by walking the
ledger between observation anchors. The headline portfolio number is a
sum of holdings × prices through a [price graph](/concepts/pricing/);
the chart is a daily-grain cache ([rollup](/concepts/rollup/)) that
rebuilds from the same primitives.

## The five primitives

```
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                   ┌──────────────┐                                    │
│                   │   accounts   │── one per (user, institution, name)│
│                   └──────┬───────┘                                    │
│                          │                                            │
│                          ▼                                            │
│                   ┌──────────────┐         ┌──────────────┐           │
│                   │   holdings   │────────▶│    tokens    │           │
│                   │ (positions)  │         │  (assets)    │           │
│                   └──────┬───────┘         └──────┬───────┘           │
│                          │                        │                   │
│             ┌────────────┴──────────────┐         ▼                   │
│             ▼                           ▼   ┌──────────────┐          │
│  ┌────────────────────┐    ┌────────────────│ token_prices │          │
│  │ holding_           │    │ holding_       └──────────────┘          │
│  │  transactions      │    │  balance_                                │
│  │ (append-only       │    │  observations                            │
│  │  ledger)           │    │ (append-only                             │
│  └────────────────────┘    │  anchors)                                │
│                            └────────────────┘                         │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

| Primitive | Role | Mutability |
|---|---|---|
| [`accounts`](/concepts/accounts/) | Container at one institution (one Kraken account, one Metamask wallet) | Mutable metadata; never deleted while holdings reference it. |
| [`holdings`](/concepts/holdings/) | A single `(account, token)` position with a `balance` string | Current state — *the only mutable balance*. |
| [`tokens`](/concepts/tokens/) | Tradeable asset: fiat, crypto, equity, private | Mutable metadata; deduplicated globally. |
| [`holding_transactions`](/concepts/transactions/) | Immutable ledger row per economic event (buy, sell, deposit, transfer, fee, …) | **Append-only.** Never updated, never deleted in normal operation. |
| [`holding_balance_observations`](/concepts/observations/) | "At time T, this holding's balance was B, per source S" | **Append-only.** Live syncs, statement closes, screenshots, user entry, manual corrections. |

## Derived data

| Derived | Source | Computed by |
|---|---|---|
| Balance at past time T | observations + transactions + current holding | [`BalanceAtTimeService`](/concepts/balance-reconstruction/) |
| FX/price conversion | `token_prices` graph | [`PriceGraphService`](/concepts/pricing/), hub-routed |
| Daily portfolio totals | the four above, per scope | [`portfolio_value_daily`](/concepts/rollup/), nightly |
| Holding coverage quality | per-holding tx + observation timestamps | [`holding_coverage`](/concepts/observations/), per-ingest |

The rollup is **purely a cache** — drop it and the nightly job
rebuilds it. The ledger and observations are the load-bearing truth.

## User-defined organisation

| Concept | Role |
|---|---|
| [Vaults](/concepts/vaults/) | Savings goals. Allocate percentage splits of holdings to each goal (25% of BTC → house deposit, 75% → retirement). Compute progress toward a target. |
| [Groups](/concepts/groups/) | Free-form tags (Crypto, Retirement, Side projects). Many-to-many to holdings *and* accounts. Pure UI labels — they don't change calculations. |
| [APY configs](/concepts/apy/) | Per-holding yield rules. A nightly cron appends `kind='interest'` transactions according to the schedule. |

## Where the data comes from

| Source | Examples |
|---|---|
| **Exchange syncs** | Binance, Kraken, Bybit, … — credentialed reads on a schedule. |
| **Brokerage syncs** | Interactive Brokers Flex Web Service, Wise. |
| **On-chain syncs** | Etherscan (EVM), Helius (Solana), Bitcoin RPC, Tron, TON, ENS. |
| **AI parsing** | Screenshot → structured holdings via OpenAI Vision. |
| **Manual entry** | Typed in by the user — stored as a [synthetic "manual" institution](/concepts/manual-assets/). |
| **CSV / statement import** | Bank statements, brokerage exports. |

Each source produces *both* transactions (with a deduped `external_id`)
and observations (`source: 'sync-capture'`). Reconciliation
([`OpeningBalanceReconciliationService`](/concepts/observations/))
fills the gap when the ledger doesn't fully explain the current
holding balance — it synthesises an `opening_balance` transaction at
the start of known history.

## Pricing is its own graph

There is **no USD-canonical column**. Every price is stored in its
native quote (a Kraken BTC/EUR trade has `priceNativeTokenId = EUR`,
not USD). Conversions walk the implicit graph implied by
`token_prices` rows: direct, then reverse direct, then one-hop via
USD / USDT / EUR. See [Pricing & the price graph](/concepts/pricing/)
for the routing rules and the staleness contract.

## The headline reconciles with the chart

The dashboard's headline portfolio total and the chart's latest point
**must agree by construction**. Both apply the same
[holding-inclusion rule](/decisions/holding-inclusion-rule/) — hidden
holdings, inactive holdings, and scam-flagged tokens are excluded
from both. The rule lives twice (in TypeScript for the dashboard
read path, in SQL for the chart) but in two places that are tested
to stay in sync.

## Three deployment tiers, one binary

The same four services run three ways. Two env vars switch tiers:

- `SCANI_CLOUD_URL` — where to send outbound third-party calls.
  Tier 1: `http://data-provider:8082` (same machine). Tier 2/3: a
  hosted data-provider endpoint.
- `SCANI_CLOUD_API_KEY` — the bearer token the api + worker present.

See [Tier model](/self-hosting/tier-model/).

## See also

- [Holdings](/concepts/holdings/)
- [Transactions](/concepts/transactions/)
- [Observations & coverage](/concepts/observations/)
- [Balance reconstruction](/concepts/balance-reconstruction/)
- [Pricing & the price graph](/concepts/pricing/)
- [Portfolio value rollup](/concepts/rollup/)
- [Why an append-only ledger](/decisions/append-only-ledger/)
