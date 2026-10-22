---
title: Provider matrix
description: Which provider integrations exist, what capabilities they implement, and what env var unlocks them.
sidebar:
  order: 7
---

Each provider lives in `packages/clients/providers/src/providers/`
and implements one or more [capability interfaces](/contributing/adding-a-provider/#the-capability-based-interface-model).
Without the relevant env var the provider still registers and
degrades — it returns nothing, or falls back to a keyless public tier —
rather than refusing the call. No route returns an error to say a key is
missing, so [How to tell what's
enabled](/self-hosting/tier1/optional-keys/#how-to-tell-whats-enabled)
is the check.

## Pricing

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| CoinGecko | `COINGECKO_API_KEY` | price, token-identity | Public tier (no key) works but is rate-limited. |
| Finnhub | `FINNHUB_API_KEY` | price, token-identity | Public equities. |
| DeFiLlama | _none_ | price, token-identity | Free. Coin spec is `chain:address` or `coingecko:slug`. |
| Frankfurter | _none_ | price | Fiat FX rates from named central banks, through Frankfurter v2. A pair both of whose currencies the [European Central Bank](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) publishes is read from the ECB's table; one with a currency only the [Bank of Russia](https://www.cbr.ru/eng/currency_base/daily/) publishes (RUB, KZT, AED, …) from the Bank of Russia's. Both sides always from one bank. The Google Sheets converter and the base-currency converter read the same client. |
| BLS | _none_ | inflation index | US consumer price index (CPI-U) for the returns card's inflation line. Public API v1, no key, 25 requests a day. |
| Yahoo Finance | _none_ | price | Backup pricing source for equities. |
| Google Sheets | `GOOGLE_SHEETS_ID` + `GOOGLE_SERVICE_ACCOUNT_KEY` (base64 JSON) | price (current only) | Per-user manual-asset prices read from a sheet. Lives in its own workspace (`packages/clients/providers-google-sheets`). Historical falls through to Frankfurter. |

## Exchanges

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| Binance | _user-supplied API key/secret_ | balance, transaction | HMAC-signed, like every other exchange here. |
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
| bunq | _user-supplied personal API key_ | balance, transaction | **Self-hosted Scani only.** bunq allows a personal API key only in software you run yourself, so the hosted product lists bunq and refuses to connect it. There, export a statement from bunq as MT940 or CSV and import that instead; bunq offers no CAMT.053. Connecting registers the key with bunq once and stores that registration encrypted beside it. A standard key is tied to the IPv4 address it was first used from, so the API and the worker must reach bunq from the same address, or the key must allow all IP addresses (a setting in the bunq app). |
| Investec | _user-supplied client ID, secret and API key_ | balance, transaction | **Self-hosted Scani only.** Investec lets your own credentials serve you or your business; a platform for many clients needs Investec's own onboarding, so the hosted product lists Investec and refuses to connect it. South Africa Private Bank accounts. Connecting refuses an API key that can transfer or pay, so give it only account, balance and transaction access. With no start date, Investec returns the last 180 days. |
| Fio banka | _user-supplied API token_ | balance, transaction | **Self-hosted Scani only.** Fio holds you liable for any use of your token by someone else, so the hosted product lists Fio banka and refuses to connect it; it points to a CSV statement instead. One token covers one account, and Fio allows one call per token every 30 seconds. With no start date the read covers 90 days: older movements need an unlock in internetbanking first. Choose the "Sledování účtu" (account monitoring) permission; even a token that may enter payment orders cannot authorise them. |

## Blockchains

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| Etherscan V2 | `ETHERSCAN_API_KEY` | balance, transaction, token-identity | **One key covers every EVM chain Scani reads** (Ethereum, Polygon, Arbitrum, Optimism, Base, BNB, …). |
| Helius | `HELIUS_API_KEY` | balance, transaction, token-identity | Solana SPL + native. |
| Bitcoin | _none_ | balance, transaction | Public RPC. |
| Litecoin | _none_ | balance, transaction, address validation | Litecoin Space mainnet API. Confirmed transaction history; current balance includes mempool changes. Supports Base58Check and Bech32/Bech32m addresses. MWEB addresses are not supported. |
| Tron | _none_ | balance, transaction | |
| TON | _none_ | balance, transaction | |
| ENS | _none_ | identity | Resolves `vitalik.eth` → address. |

## AI / parsing

| Provider | Env var | Capabilities | Notes |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | AI inference | Model pinned to `gpt-5.6-luna` for both text and vision. Not configurable. |
| AI stub | `STUB_AI=1` | AI inference (stub) | Test-only. Returns a fixed holdings payload so e2e tests don't depend on a real AI provider. Refused in production by the data-provider env schema. |
| Chain stub | `STUB_CHAIN_DATA=1` | Balances, transactions, address validation (stub) | Test-only. Answers every chain from a local fixture so e2e tests don't depend on a public chain API's rate limiter. Address-shape checks are the real providers' own, so a stubbed boot cannot disagree with a live one about what a valid address looks like. Refused in production by the api, worker and data-provider env schemas. |

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
| bunq | New. Built and tested against bunq's sandbox; not yet run against a real account. |
| Investec | New. Built and tested against Investec's sandbox; not yet run against a real account. |
| Fio banka | New. Built from Fio's API document; Fio has no sandbox, so it has not run against an account. |
| Bitcoin, Tron, TON, ENS | Functional. Public RPCs are slow on big wallets. |
| Litecoin | New adapter. Automated tests cover pagination, address checksums and normalization; large-wallet history is bounded and reported as partial when capped. |
| OpenAI Vision | Solid for screenshots; quality degrades on dark-mode or non-English UIs. |

## Adding a provider

See [Adding a provider](/contributing/adding-a-provider/) — this
is the highest-leverage kind of contribution.

## See also

- [Optional integration keys](/self-hosting/tier1/optional-keys/)
- [Adding a provider](/contributing/adding-a-provider/)
- [Tokens & market segments](/concepts/tokens/)
- [Token identity & enrichment](/concepts/token-identity/)
