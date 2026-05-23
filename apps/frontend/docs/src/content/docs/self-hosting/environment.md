---
title: Environment variables
description: Required and optional env vars for a Scani deployment.
---

The full annotated list lives in
[`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example) at
the repo root. This page covers the ones you actually need to set.

For the full reference table organized by package, see
[Reference → Environment variables](/reference/environment/).

## Required for any real deployment

| Variable                          | Purpose                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | Postgres 16+ connection string                                                                |
| `REDIS_URL`                       | Redis 7+ connection string                                                                    |
| `BETTER_AUTH_SECRET`              | 32+ chars; rotating it invalidates every session                                              |
| `ENCRYPTION_KEY`                  | 32 hex chars; **must match between api and worker**                                           |
| `JOBS_HMAC_SECRET`                | Shared secret for HMAC-gated job admin endpoints                                              |
| `FRONTEND_URL` / `BACKEND_URL`    | What the browser sees; powers CORS + cookies                                                  |
| `S3_*`                            | Object storage (any S3-compatible store; MinIO locally, R2 / S3 / B2 / … in prod)             |
| `SCANI_CLOUD_URL`                 | Where the data-provider lives (see [Tier model](/self-hosting/tier-model/))         |
| `SCANI_CLOUD_API_KEY`             | Bearer token the api + worker present to reach the data-provider                              |

## Optional integration keys

Each one unlocks specific functionality. The corresponding tRPC router returns
a `PRECONDITION_FAILED` error at call-time if the key is unset — so unset keys
fail loudly rather than silently misbehaving.

### Pricing

- `COINGECKO_API_KEY`, `FINNHUB_API_KEY`

### AI / screenshot parsing

- `OPENAI_API_KEY` — screenshot parsing
- `PERPLEXITY_API_KEY`, `DEEPSEEK_API_KEY` — token-identity backfill

### On-chain

- `ETHERSCAN_API_KEY` — EVM wallet balances (one key covers all EVM chains)
- `HELIUS_API_KEY` — Solana balances

### Exchange OAuth

- `BINANCE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` — Binance exchange
  connection via OAuth

### Email transport

- `FASTMAIL_API_TOKEN` — Fastmail JMAP delivery; **or**
- `SMTP_URL` + `SMTP_FROM` — any SMTP server (Mailpit in dev, your provider
  in prod)

## How env vars are validated

Two layers, with a strict ownership rule:

- **App-level** (`apps/*/src/config/env.ts`) owns env vars that belong to the
  *app itself* — its bind port, its database connection, its frontend origin.
  Each app parses `process.env` once at boot via a zod schema and exits with
  a clear error listing every failing variable.
- **Package-level** (`packages/infra/<pkg>/src/config.ts`) owns env vars that
  belong to *that package* — `FASTMAIL_API_TOKEN` for `@scani/email`, `S3_*`
  for `@scani/storage`, `ENCRYPTION_KEY` for `@scani/security`.

Apps that depend on a package **do not redeclare** that package's env vars in
their own schema — the package owns validation.

Every package config uses the same pattern: optional in dev/test, required
in production. Production failures are non-recoverable misconfigurations;
dev passthroughs let contributors boot without ceremony.
