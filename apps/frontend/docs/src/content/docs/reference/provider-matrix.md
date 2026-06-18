---
title: Provider matrix
description: Which provider integrations exist, what capabilities they implement, and what env var unlocks them.
sidebar:
  order: 7
---

Each provider lives in `packages/clients/providers/src/providers/`
and implements one or more [capability interfaces](/contributing/adding-a-provider/#the-capability-based-interface-model).
Without the relevant env var, the capability is disabled and the
tRPC call returns `PRECONDITION_FAILED`.

## Pricing

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| CoinGecko | `COINGECKO_API_KEY` | price, token-identity | Public tier (no key) works but is rate-limited. |
| Finnhub | `FINNHUB_API_KEY` | price, token-identity | Public equities. |
| DeFiLlama | _none_ | price, token-identity | Free. Coin spec is `chain:address` or `coingecko:slug`. |
| Frankfurter | _none_ | price | Free FX rates between fiat currencies. |
| Yahoo Finance | _none_ | price | Backup pricing source for equities. |
| Google Sheets | `GOOGLE_SHEETS_ID` + `GOOGLE_SERVICE_ACCOUNT_KEY` (base64 JSON) | price (current only) | Per-user manual-asset prices read from a sheet. Lives in its own workspace (`packages/clients/providers-google-sheets`). Historical falls through to Frankfurter. |

## Exchanges

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| Binance | `BINANCE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI` | balance, transaction | OAuth flow. Other exchanges use user-pasted API keys. |
| Kraken | _user-supplied API key/secret_ | balance, transaction, price, token-identity | Full breadth. |
| Bybit | _user_ | balance, transaction | |
| OKX | _user_ | balance, transaction | |
| Coinbase | _user_ | balance, transaction | |
| KuCoin | _user_ | balance, transaction | |
| Gate.io | _user_ | balance, transaction | |
| HTX (Huobi) | _user_ | balance, transaction | |
| Bitstamp | _user_ | balance, transaction | |
| Bitget | _user_ | balance, transaction | |
| Gemini | _user_ | balance, transaction | |
| MEXC | _user_ | balance, transaction | |

User-supplied credentials are AES-256-GCM-encrypted in
`user_integration_credentials` with `ENCRYPTION_KEY`. They never
leave your api.

## Brokerages & banks

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| Interactive Brokers | _user-supplied Flex Web Service token_ | balance, transaction | Flex token + query ID configured per user. |
| Wise | _user-supplied API token_ | balance, transaction | |
| Airwallex | _user-supplied Client ID + API key_ | balance, transaction | Client ID + API key exchanged for a 30-min bearer token per call. |

## Blockchains

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| Etherscan V2 | `ETHERSCAN_API_KEY` | balance, transaction, token-identity | **One key covers every V2-supported EVM chain** (Ethereum, Polygon, Arbitrum, Optimism, Base, BNB, …). |
| Helius | `HELIUS_API_KEY` | balance, transaction, token-identity | Solana SPL + native. |
| Bitcoin | _none_ | balance, transaction | Public RPC. |
| Tron | _none_ | balance, transaction | |
| TON | _none_ | balance, transaction | |
| ENS | _none_ | identity | Resolves `vitalik.eth` → address. |

## AI / parsing

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | AI inference | Default vision model: `gpt-4o`; override with `OPENAI_VISION_MODEL`. |
| Perplexity | `PERPLEXITY_API_KEY` | AI inference | Token-identity enrichment helper. Optional. |
| DeepSeek | `DEEPSEEK_API_KEY` | AI inference | Token-identity enrichment helper. Optional. |
| AI stub | `STUB_AI=1` | AI inference (stub) | Test-only. Returns a fixed holdings payload so e2e tests don't depend on a real AI provider. Refused in production by the data-provider env schema. |

## Picking what to enable

Minimum useful set for a self-hoster with a connected crypto
exchange:

- `ETHERSCAN_API_KEY` if you have an EVM wallet.
- `HELIUS_API_KEY` if you have a Solana wallet.
- Either `COINGECKO_API_KEY` (paid tier) or rely on the free
  CoinGecko fallback if your portfolio is small.
- `OPENAI_API_KEY` if you want screenshot import.

Public-equity support adds `FINNHUB_API_KEY`.

Brokerages and banks don't need an operator-side env var — they
work with per-user credentials only.

## Maturity

| Provider | Maturity |
|---|---|
| Etherscan V2, Helius, CoinGecko, Frankfurter | Solid. Used by every Scani deployment. |
| Kraken | Solid. Most-tested exchange adapter. |
| Binance, Coinbase, Bybit, OKX | Solid for balance + recent transactions. Edge cases on multi-account / sub-account setups. |
| KuCoin, Gate, HTX, Bitstamp, Gemini, MEXC, Bitget | Functional. Less battle-tested. |
| IBKR (Flex), Wise, Airwallex | Functional. Flex query setup is the main user friction. |
| Bitcoin, Tron, TON, ENS | Functional. Public RPCs are slow on big wallets. |
| OpenAI Vision | Solid for screenshots; quality degrades on dark-mode or non-English UIs. |
| Perplexity, DeepSeek | Optional supplements; not required. |

## Adding a provider

See [Adding a provider](/contributing/adding-a-provider/) — this
is the highest-leverage kind of contribution.

## See also

- [Optional integration keys](/self-hosting/tier1/optional-keys/)
- [Adding a provider](/contributing/adding-a-provider/)
- [Tokens & market segments](/concepts/tokens/)
- [Token identity & enrichment](/concepts/token-identity/)
