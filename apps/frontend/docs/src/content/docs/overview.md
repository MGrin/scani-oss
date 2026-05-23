---
title: Overview
description: What Scani is, what it tracks, and how it's built.
---

**Scani** is a self-hostable, open-source portfolio tracker for crypto and
traditional assets — one view across every asset you care about: exchanges,
on-chain wallets, brokerages, and manual entries.

The same TypeScript codebase runs three ways: fully self-hosted, against a
hosted data-provider, or as a managed service. MIT licensed.

## What you get out of the box

- **Holdings + transactions** across crypto and traditional assets, with FX
  conversion and historical value rollups.
- **Exchange connections** for Binance, Kraken, Bybit, OKX, Coinbase, KuCoin,
  Gate.io, HTX, Bitfinex, Bitstamp, Crypto.com, Gemini, MEXC, BitMart, Phemex,
  ProBit.
- **Brokerage / bank connections** for Interactive Brokers (Flex Web Service)
  and Wise.
- **On-chain balances** for Ethereum + every EVM chain Etherscan V2 supports
  (Polygon, Arbitrum, Optimism, Base, …), Solana (via Helius), Bitcoin, Tron,
  TON, and ENS resolution.
- **Pricing** from CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Yahoo
  Finance, and Google Sheets (for manual-asset prices).
- **AI-assisted import** — screenshot parsing via OpenAI; Perplexity / DeepSeek
  for token-identity backfill.
- **Auth** via Better-Auth (magic-link email + sessions in Postgres). No
  third-party identity provider required.

The stack is self-contained — no external service credentials required to boot.
Provider API keys unlock specific integrations.

## What's next

- New here? Read the [Quickstart](/quickstart/).
- Deploying it? See [Self-hosting](/self-hosting/tier-model/).
- Contributing? Start with [How to contribute](/contributing/how-to/).
