---
title: Optional integration keys
description: Provider API keys that unlock specific functionality. Missing keys cause the corresponding tRPC routes to return PRECONDITION_FAILED — the rest of the app keeps working.
sidebar:
  order: 4
---

Scani's integrations are **independently unlockable**. A missing
key causes the corresponding tRPC route to return
`PRECONDITION_FAILED` at call-time; nothing else breaks. You can
enable integrations one at a time as you obtain keys.

All of these are read by the [data-provider](/decisions/three-tier-model/),
not by the api or worker. In Tier 1, that's the data-provider on
your compose network; in Tier 2/3, the hosted data-provider has its
own copies and the user-side `.env` doesn't need them.

## Pricing

| Variable | Provider | What it unlocks |
|---|---|---|
| `COINGECKO_API_KEY` | [CoinGecko](https://www.coingecko.com/en/api) | Paid-tier crypto prices (current + historical). Without a key, falls back to the public CoinGecko tier (rate-limited). |
| `FINNHUB_API_KEY` | [Finnhub](https://finnhub.io/) | Public-equity prices (NYSE, NASDAQ, LSE, …). |

Note: fiat / FX pricing uses [Frankfurter](https://frankfurter.app/),
which requires no key.

## AI / parsing

| Variable | Provider | What it unlocks |
|---|---|---|
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com/) | Screenshot import via Vision. Without a key, screenshot upload is disabled. |
| `OPENAI_VISION_MODEL` | OpenAI | Which model to use. Default `gpt-4o`. |
| `PERPLEXITY_API_KEY` | [Perplexity](https://www.perplexity.ai/) | Token-identity backfill enrichment. Optional — backfill works without it via other providers. |
| `DEEPSEEK_API_KEY` | [DeepSeek](https://www.deepseek.com/) | Token-identity backfill enrichment. Optional. |

## On-chain

| Variable | Provider | What it unlocks |
|---|---|---|
| `ETHERSCAN_API_KEY` | [Etherscan V2](https://etherscan.io/apis) | EVM wallet balances + transactions for **every** EVM chain V2 supports — Ethereum, Polygon, Arbitrum, Optimism, Base, BNB, etc. One key covers all of them. |
| `HELIUS_API_KEY` | [Helius](https://www.helius.dev/) | Solana balances and SPL token transactions. |

Bitcoin, Tron, TON, and ENS resolution use public RPCs without
key requirements. The provider implementations live in
`packages/clients/providers/src/providers/`.

## Exchange OAuth

Most exchanges use API-key + secret credentials the user pastes into
the app. Binance is the exception — it uses OAuth, which requires
operator-side configuration:

| Variable | What it does |
|---|---|
| `BINANCE_OAUTH_CLIENT_ID` | Issued when you register your deployment with Binance. |
| `BINANCE_OAUTH_CLIENT_SECRET` | Issued alongside the client ID. |
| `BINANCE_OAUTH_REDIRECT_URI` | The callback URL Binance will redirect to after the user authorises. Must match what you register with Binance, e.g. `https://api.scani.example.com/auth/binance/callback`. |

Without these set, the **Binance** integration is unavailable; every
other exchange continues to work via the standard API-key flow.

## Sentry (error tracking)

| Variable | What it does |
|---|---|
| `SENTRY_DSN` | Server-side error tracking. No DSN = SDK no-op; nothing is sent. |
| `SENTRY_ENVIRONMENT` | Optional tag (`production`, `staging`). |
| `SENTRY_RELEASE` | Optional release identifier. |
| `VITE_SENTRY_DSN` | Browser-side error tracking. |
| `VITE_SENTRY_ENABLED` | Set to `true` to enable client-side reporting. |

Payloads are passed through `packages/business/shared/src/utils/sentry-scrubber.ts`
before send, which strips credentials / tokens / known PII.

## Cloud-management (Tier 2/3 hosted data-provider only)

Ignored in Tier 1 single-tenant mode.

| Variable | What it does |
|---|---|
| `CLOUD_MANAGEMENT_ENABLED` | Turns on the cloud-management surface on the data-provider — DB-backed API keys, Better-Auth cookie sessions for a management console, per-request metering. |
| `BETTER_AUTH_URL` | Public URL of the data-provider (used for cookie scope on the management console). |
| `CLOUD_FRONTEND_ORIGIN` | Origin of the cloud-management console (for CORS). |

## How to tell what's enabled

Each tRPC route that depends on a provider returns
`PRECONDITION_FAILED` with a message naming the missing env var:

```json
{ "error": { "code": "PRECONDITION_FAILED",
             "message": "OPENAI_API_KEY is not configured" } }
```

The SPA renders these as a soft empty-state in the UI rather than a
crash.

## See also

- [Required environment variables](/self-hosting/tier1/required-env/)
- [Provider matrix](/reference/provider-matrix/)
- [Environment variables reference](/reference/environment/)
