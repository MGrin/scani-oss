---
title: What is Scani
description: A portfolio tracker built around an append-only ledger, with first-class support for crypto and traditional assets, designed to be self-hosted.
sidebar:
  order: 1
---

Scani is a **self-hostable, open-source portfolio tracker** for crypto and
traditional assets. One database, one ledger, one dashboard across:

- **Exchanges** — Binance, Kraken, Bybit, OKX, Coinbase, KuCoin, Gate.io,
  HTX (Huobi), Bitstamp, Bitget, Gemini, MEXC.
- **Brokerages & banks** — Interactive Brokers (via Flex Web Service), Wise.
- **On-chain wallets** — Ethereum and every EVM chain Etherscan V2 supports
  (Polygon, Arbitrum, Optimism, Base, …), Solana (via Helius), Bitcoin, Tron,
  TON, plus ENS resolution.
- **Pricing** — CoinGecko, Finnhub, DeFiLlama, Frankfurter (FX), Yahoo
  Finance, and Google Sheets for manual-asset prices.
- **AI-assisted import** — OpenAI for screenshot parsing; Perplexity and
  DeepSeek for token-identity backfill.
- **Anything else** — manual holdings with manual prices. Home equity,
  private-company shares, an off-grid commodity position, a friend's IOU.

## What "self-hostable" means here

The whole stack is a few Bun services and a Postgres database. The default
local stack — `bun run dev:stack` — boots Postgres, Redis, MinIO, Mailpit,
and every Scani service in Docker. **No external account, no API key, no
credit card is required to log in and start using it.**

Provider API keys (CoinGecko, OpenAI, Etherscan, …) unlock specific
integrations when you want them. Without them, manual holdings still work,
FX pricing still works (the FX provider has no key requirement), and the
screenshot store still works (local MinIO container).

## The shape of the product

Scani is structured around a small set of domain concepts that map cleanly
to finance:

- A [**holding**](/concepts/holdings/) is a single (account, token) position
  with a balance.
- An [**account**](/concepts/accounts/) is a container for holdings at one
  institution — your Kraken account, your Metamask wallet, your IBKR
  brokerage account, your "manual" pseudo-account.
- An [**institution**](/concepts/accounts/) is the financial entity behind
  the account: an exchange, a bank, a brokerage, a blockchain, or a
  synthetic "manual" institution Scani creates for offline data.
- A [**token**](/concepts/tokens/) is a tradeable asset: a fiat currency,
  a cryptocurrency, an equity, or a private company.
- A [**transaction**](/concepts/transactions/) is one immutable event in an
  append-only ledger — a buy, a sell, a deposit, a withdrawal, a transfer,
  a swap, a fee, a reward, an interest payout, an airdrop.
- A [**balance observation**](/concepts/observations/) is a snapshot of a
  holding's balance at a moment in time — what a sync captured, what a
  screenshot said, what you typed in.
- A [**vault**](/concepts/vaults/) is a savings goal you allocate fractions
  of holdings against.
- A [**group**](/concepts/groups/) is a user-defined tag for organising
  holdings and accounts.

These concepts are the same whether you're looking at a Binance position
or a private-equity stake. That symmetry is the design — see
[Mental model](/concepts/mental-model/) for the one-pager.

## What Scani is not

- **Not an exchange.** Scani has no order book, no custody, no settlement.
  Read-only credentials and read-only blockchain RPCs are how it reads
  your portfolio.
- **Not a tax engine.** Cost basis, realised PnL, and FIFO/LIFO lot
  selection are tracked (see [Portfolio value rollup](/concepts/rollup/)),
  but Scani does not file returns or render jurisdiction-specific tax
  reports.
- **Not a market-data terminal.** Pricing is for portfolio valuation, not
  high-frequency trading. Intra-day prices land on the minute scale, not
  the millisecond.
- **Not a SaaS-first product.** A managed tier exists ([Tier 3](/self-hosting/tier3/)),
  but the design centre is single-tenant self-hosted. Everything else
  follows from that.

## How the codebase fits together

A four-service Bun monorepo plus a database:

| Service | What it does |
|---|---|
| `apps/backend/api` | tRPC + Elysia HTTP server. Owns per-user credentialed integrations (exchange keys, brokerage tokens) so user creds never leave the tenant boundary. Acts as the BullMQ producer. |
| `apps/backend/worker` | BullMQ consumer. Every scheduled job (pricing, balance syncs, historical backfill, transfer linking) and every user-initiated job (screenshot parse, import, delete) runs here. |
| `apps/backend/data-provider` | tRPC service that centralises every outbound third-party call (CoinGecko, OpenAI, Etherscan, …). The api and worker call it over tRPC rather than talking to upstream APIs directly. The seam between Tier 1 and Tier 2/3 lives here. |
| `apps/frontend/app` | React + Vite SPA. End-to-end type-safe with the api via tRPC. |
| Postgres + Redis + S3 | Postgres for everything durable. Redis for BullMQ, rate-limiter buckets, realtime fan-out. S3 (or compatible) for binary uploads. |

See [Repo layout](/reference/repo-layout/) for the package-by-package map.

## Why we wrote it

Most portfolio trackers are SaaS-only and crypto-only (or stocks-only).
Scani exists because a useful portfolio tool has to:

1. **Cover every venue** you actually use, custodial or not, crypto or
   not, with or without an API.
2. **Run on your hardware**, with your keys, against your database. The
   ledger of every trade you've ever made is sensitive — sending it to
   a third party should be a choice, not a precondition.
3. **Survive incomplete data.** Exchange CSVs start at export date.
   Blockchain indexers prune. Wallets get imported mid-life. The model
   has to make the headline number reconcile with the chart even when
   parts of the history are missing — see
   [Observations & coverage](/concepts/observations/).

The trade-off is more setup than a SaaS sign-up. The docs you're reading
exist to make that setup tractable.

## See also

- [Quickstart](/start/quickstart/) — the one-command local stack.
- [Mental model](/concepts/mental-model/) — the one-pager for the
  domain model.
- [Tier model](/self-hosting/tier-model/) — choosing how much you
  want to host yourself.
- [Glossary](/reference/glossary/) — every term used in these docs.
