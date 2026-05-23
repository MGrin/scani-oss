---
title: Environment variables
description: The full annotated list. Grouped by ownership (app vs package) and by required vs optional.
sidebar:
  order: 2
---

This page is the **complete** list. For the must-set subset see
[Required environment variables](/self-hosting/tier1/required-env/);
for integration keys see
[Optional integration keys](/self-hosting/tier1/optional-keys/).
The annotated source of truth is
[`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Ownership model

Two layers:

- **App-level** (`apps/*/src/config/env.ts`) — vars the app itself
  cares about (bind port, DB URL, frontend origin, session signing).
  Each app validates with zod at boot.
- **Package-level** (`packages/infra/<pkg>/src/config.ts`) — vars
  that belong to a package (`@scani/security` owns `ENCRYPTION_KEY`,
  `@scani/storage` owns `S3_*`, `@scani/email` owns
  `FASTMAIL_API_TOKEN` / `SMTP_URL`, …).

Apps that depend on a package **do not redeclare** the package's
vars. The package's `loadXConfig()` validates and caches; the app
just sets the env var.

See [Engineering conventions](/contributing/conventions/) for the
ownership rule.

## Core (required for any deployment)

| Variable | Owner | What it does |
|---|---|---|
| `NODE_ENV` | app | `production` for any real deployment. |
| `DATABASE_URL` | app | Postgres 16+ connection string. |
| `POSTGRES_POOL_MAX` | app | Per-app pool size. Set to 5 behind a connection pooler. |
| `REDIS_URL` | app | Redis 7+ connection string. |
| `PORT` | app (api / data-provider) | HTTP bind port. |
| `HOST` | app | HTTP bind host. |
| `FRONTEND_URL` | app (api) | Browser-facing SPA URL. CORS + cookie scope. |
| `BACKEND_URL` | app (api) | Browser-facing api URL. Embedded in magic-link emails. |
| `COOKIE_DOMAIN` | app (api) | Cross-subdomain cookie scope. Leave unset for same-origin. |
| `BETTER_AUTH_SECRET` | app (api) | 32+ chars. Better-Auth session signing key. |
| `JOBS_HMAC_SECRET` | app (api) | 32+ chars. HMAC for operator job endpoints. |
| `SCREENSHOT_BOT_SECRET` | app (api) | 32+ chars. Screenshot-bot sign-in bearer. |
| `ENCRYPTION_KEY` | **package** (`@scani/security`) | ≥32 chars (recommended: 64 hex chars from `openssl rand -hex 32`). AES-256-GCM. Must match api ↔ worker. |
| `LOG_ID_PEPPER` | **package** (`@scani/logging`) | 16+ chars. ID-hashing pepper. Required in production. |
| `WORKER_CONCURRENCY` | app (worker) | Max concurrent BullMQ jobs per worker. Default 4. |

## Tier wiring

| Variable | Owner | What it does |
|---|---|---|
| `SCANI_CLOUD_URL` | app (api, worker) | Where outbound third-party calls go. Tier 1: `http://data-provider:8082`. Tier 2/3: hosted endpoint. |
| `SCANI_CLOUD_API_KEY` | app (api, worker) | Bearer presented to the data-provider. |
| `DATA_PROVIDER_API_KEY` | app (data-provider) | Bearer the data-provider validates against. |
| `CLOUD_MANAGEMENT_ENABLED` | app (data-provider) | Tier 2/3 only. Enables cloud-management surface. |
| `BETTER_AUTH_URL` | app (data-provider) | Public URL of the data-provider for cloud-management cookies. |
| `CLOUD_FRONTEND_ORIGIN` | app (data-provider) | CORS origin for cloud-management console. |

## Storage

| Variable | Owner | What it does |
|---|---|---|
| `S3_ENDPOINT` | **package** (`@scani/storage`) | Server-side S3 endpoint. |
| `S3_PUBLIC_ENDPOINT` | package | URL baked into presigned URLs for the browser. |
| `S3_ACCESS_KEY_ID` | package | |
| `S3_SECRET_ACCESS_KEY` | package | |
| `S3_BUCKET` | package | Bucket name. |

## Email

| Variable | Owner | What it does |
|---|---|---|
| `FASTMAIL_API_TOKEN` | **package** (`@scani/email`) | Fastmail JMAP token. Takes precedence over SMTP. |
| `SMTP_URL` | package | `smtp://user:pass@host:port` for any SMTP server. |
| `SMTP_FROM` | package | The from address for outbound mail. |

## Logging

| Variable | Owner | What it does |
|---|---|---|
| `LOG_LEVEL` | package (`@scani/logging`) | `debug`, `info`, `warn`, `error`. Default `info`. |
| `LOG_PRETTY` | package | Pretty-print. Default `false` in production. |
| `LOG_SQL_QUERIES` | package | Log Drizzle queries. Default `false`. |
| `SERVICE_NAME` | app | Set automatically by compose (`api`, `worker`, `data-provider`). |

## Provider keys (read by the data-provider)

In Tier 1 these live on your data-provider; in Tier 2/3 on the
hosted data-provider.

| Variable | Provider | Unlocks |
|---|---|---|
| `COINGECKO_API_KEY` | CoinGecko | Paid-tier crypto prices. |
| `FINNHUB_API_KEY` | Finnhub | Public-equity prices. |
| `OPENAI_API_KEY` | OpenAI | Screenshot parsing. |
| `OPENAI_VISION_MODEL` | OpenAI | Model selection. Default `gpt-4o`. |
| `PERPLEXITY_API_KEY` | Perplexity | Token-identity enrichment. Optional. |
| `DEEPSEEK_API_KEY` | DeepSeek | Token-identity enrichment. Optional. |
| `ETHERSCAN_API_KEY` | Etherscan V2 | All EVM wallet balances + transactions. |
| `HELIUS_API_KEY` | Helius | Solana balances + transactions. |
| `BINANCE_OAUTH_CLIENT_ID` | Binance | OAuth flow. |
| `BINANCE_OAUTH_CLIENT_SECRET` | Binance | OAuth flow. |
| `BINANCE_OAUTH_REDIRECT_URI` | Binance | OAuth callback URL. |

## Observability

| Variable | Owner | What it does |
|---|---|---|
| `SENTRY_DSN` | app | Server-side Sentry. No DSN = no-op. |
| `SENTRY_ENVIRONMENT` | app | Tag (`production`, `staging`). |
| `SENTRY_RELEASE` | app | Release identifier. |
| `VITE_SENTRY_DSN` | app (frontend) | Browser-side Sentry. Baked at build time. |
| `VITE_SENTRY_ENABLED` | app (frontend) | Enable client-side reporting. |
| `VITE_API_URL` | app (frontend) | URL the SPA calls for `/api`. Bun-bundled image bakes `/api`. |

## Validation pattern

Every loader uses zod and the helpers from `@scani/config`:

- `isProduction` — `process.env.NODE_ENV === 'production'` at load.
- `urlSchema` / `httpsUrlInProduction` — URL with prod-only https
  requirement.
- `requiredInProd(schema, name)` — returns the schema unchanged in
  prod, `.optional()` everywhere else. Lets dev/test boot without
  the var; prod refuses to start without it.

On a parse failure, the loader throws with a message listing every
failing variable:

```
@scani/security env misconfigured:
  - ENCRYPTION_KEY: ENCRYPTION_KEY required in production
```

## Adding a new env var

1. **Where does it belong?** If it's about a package's behaviour
   (a new third-party API key, a logging knob), it goes in that
   package's `src/config.ts`. If it's about an app (a new bind
   address), it goes in `apps/*/src/config/env.ts`.
2. Add it to root `.env.example` with an annotation.
3. Add it to the relevant app's `.env.example` (so
   `scripts/sync-env.ts` propagates it to the per-app `.env`).
4. Validate it in the right loader.
5. Document it on this page and on
   [Required env](/self-hosting/tier1/required-env/) or
   [Optional keys](/self-hosting/tier1/optional-keys/).

## See also

- [Required environment variables](/self-hosting/tier1/required-env/)
- [Optional integration keys](/self-hosting/tier1/optional-keys/)
- [Engineering conventions](/contributing/conventions/) — env-var
  ownership rule.
- `.env.example` in the repo root for the canonical comments.
