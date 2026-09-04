---
title: Optional integration keys
description: Provider API keys that unlock specific functionality. Read by the api and worker on every tier. Most degrade silently rather than failing, so check the boot line.
sidebar:
  order: 4
---

Scani's integrations are **independently unlockable**. You can
enable them one at a time as you obtain keys; nothing else breaks
while a key is missing.

These are read by the **api and the worker**, on every tier. All
three backend services boot the provider registry in `direct` mode
and call these upstreams themselves, so pointing `SCANI_CLOUD_URL` at
a hosted data-provider does **not** move them — see
[Tier 2: you still need your provider API
keys](/self-hosting/tier2/overview/#you-still-need-your-provider-api-keys).

:::caution[Most of these degrade silently]
Only the OpenAI path fails loudly. CoinGecko, Finnhub, Etherscan and
Helius each have a keyless branch that keeps working at reduced
capability, so a stack with none of them set comes up green on every
health check and then serves worse data. [How to tell what's
enabled](#how-to-tell-whats-enabled) is the check.
:::

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
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com/) | Screenshot and document parsing via Vision. Without a key the provider throws on every call, so the parse job fails — the upload itself still succeeds. |

`PERPLEXITY_API_KEY` and `DEEPSEEK_API_KEY` are read by provider
implementations that **no backend service registers**
(`aiPerplexityFactory` and `aiDeepseekFactory` are exported and never
passed to `buildProviderRegistry`). Setting them has no effect today.

The model is not configurable: `gpt-5.6-luna` is a constant in
`packages/clients/providers/src/providers/ai-openai/index.ts`, used for
both text and vision. It is pinned rather than merely undocumented —
the token-limit parameter name, the temperature handling, whether a PDF
may be sent as a `file` part, and the per-token pricing used for cost
attribution were all measured against that model, so changing the id
alone would leave four other settings wrong.

## On-chain

| Variable | Provider | What it unlocks |
|---|---|---|
| `ETHERSCAN_API_KEY` | [Etherscan V2](https://etherscan.io/apis) | EVM wallet balances + transactions for **every** EVM chain V2 supports — Ethereum, Polygon, Arbitrum, Optimism, Base, BNB, etc. One key covers all of them. |
| `HELIUS_API_KEY` | [Helius](https://www.helius.dev/) | Solana balances and SPL token transactions. |

Bitcoin, Tron, TON, and ENS resolution use public RPCs without
key requirements. The provider implementations live in
`packages/clients/providers/src/providers/`.

## Exchanges

**No exchange needs an operator-side key.** Every exchange — Binance
included — uses API-key + secret credentials the user pastes into the
app, encrypted per user. There is nothing on this page to set for
them.

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

**Don't wait for an error — most of these never produce one.** The
provider registry emits one summary line at boot in every backend
service, whether or not anything is degraded:

```sh
docker compose -f docker-compose.prod.yml logs api worker \
  | grep 'provider credentials:'
```

Production logs are JSON (`LOG_PRETTY` is forced off when
`NODE_ENV=production`), so the line arrives as a `msg` field:

```
{… "mode":"direct","msg":"✅ provider credentials: 5/5 keyed · keyed: coingecko, etherscan, finnhub, openai, solana · degraded: none"}

{… "degraded":["COINGECKO_API_KEY","OPENAI_API_KEY"],"mode":"direct","msg":"⚠️  provider credentials: 3/5 keyed · keyed: etherscan, finnhub, solana · degraded: coingecko [COINGECKO_API_KEY unset → drops to the public rate-limited tier instead of the Pro host]; openai [OPENAI_API_KEY unset → throws on every call, so screenshot and document parsing fail]"}
```

The degraded line also carries a `degraded` array of just the unset
variable names, which is the cheaper thing to alert on.

The healthy line prints too, so a provider quietly dropping out of the
keyed set shows up as a change rather than as silence.

The api serves the same record over HTTP:

```sh
docker compose -f docker-compose.prod.yml exec api \
  curl -fsS http://localhost:3001/health/deep | jq .providerCredentials
```

An unkeyed provider deliberately does **not** turn `/health/deep` red
— it is a configuration choice, not an outage. The worker has no HTTP
health endpoint; its boot line is the only signal.

**No route refuses a call because a provider key is missing**, so do
not wait for one. A keyless provider degrades, and the OpenAI path
throws inside the queued screenshot-parse job rather than in the route
that accepted the upload — the upload returns 200 either way.
`PRECONDITION_FAILED` is returned elsewhere in the API (a manual
holding has nothing to refresh; an upload never landed), never to
report an unset key.

## See also

- [Required environment variables](/self-hosting/tier1/required-env/)
- [Provider matrix](/reference/provider-matrix/)
- [Environment variables reference](/reference/environment/)
