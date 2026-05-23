---
title: Provider integrations
description: Every external service Scani knows how to talk to, and how the provider system is organized.
---

Out of the box, Scani knows how to talk to:

## Exchanges

Binance, Kraken, Bybit, OKX, Coinbase, KuCoin, Gate.io, HTX, Bitfinex,
Bitstamp, Crypto.com, Gemini, MEXC, BitMart, Phemex, ProBit.

## Brokerages / banks

- **Interactive Brokers** — via Flex Web Service
- **Wise**

## On-chain

- **Ethereum + every EVM chain Etherscan V2 supports** (Polygon, Arbitrum,
  Optimism, Base, …)
- **Solana** via Helius
- **Bitcoin**
- **Tron**
- **TON**
- **ENS** resolution

## Pricing

CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Yahoo Finance, Google Sheets
(for manual-asset prices).

## AI

OpenAI (screenshot parsing), Perplexity, DeepSeek.

## How providers are organized

Every provider has a directory under
[`packages/clients/providers/src/providers/`](https://github.com/MGrin/scani-oss/tree/main/packages/clients/providers/src/providers)
with a typed adapter behind a **capability interface**:

- One directory per provider (one source of truth for that external service)
- Each adapter implements one or more capability interfaces (pricing,
  balances, transactions, AI inference, token-identity)
- Apps depend on the capability, not the concrete adapter — swapping
  CoinGecko for a different pricing provider is a registry change, not a
  caller change

All outbound 3rd-party calls flow through the
[`data-provider`](/scani-oss/concepts/architecture/) service — the api and
worker call it over tRPC via `@scani/cloud-client` rather than hitting
upstream APIs directly. This is what makes the
[tier model](/scani-oss/self-hosting/tier-model/) possible.

## Adding a new provider

**Adding a new provider is one of the highest-leverage contributions.**
Start with [Contributing → How to contribute](/scani-oss/contributing/how-to/)
and the
[`packages/clients/providers/`](https://github.com/MGrin/scani-oss/tree/main/packages/clients/providers)
directory.
