---
title: Environment variables
description: Full reference of every env var Scani reads, organized by owner.
---

The canonical annotated list lives in
[`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).
This page groups them by which app or package owns validation.

For the must-set subset, see
[Self-hosting → Environment variables](/scani-oss/self-hosting/environment/).

## App-level

App-level env vars belong to the *app itself* — its bind port, its database
connection, its frontend origin. Each app parses `process.env` once at boot
via a zod schema in `apps/<app>/src/config/env.ts` and exits with a clear
error listing every failing variable.

### `apps/backend/api`

| Variable                | Required in prod | Purpose                                                |
| ----------------------- | ---------------- | ------------------------------------------------------ |
| `DATABASE_URL`          | yes              | Postgres 16+ connection string                         |
| `REDIS_URL`             | yes              | Redis 7+ connection string                             |
| `BETTER_AUTH_SECRET`    | yes              | 32+ chars; rotates every session if changed            |
| `JOBS_HMAC_SECRET`      | yes              | Shared secret for HMAC-gated job admin endpoints       |
| `FRONTEND_URL`          | yes              | Browser-visible frontend origin (CORS + cookies)       |
| `BACKEND_URL`           | yes              | Browser-visible api origin                             |
| `SCANI_CLOUD_URL`       | yes              | Where the data-provider lives                          |
| `SCANI_CLOUD_API_KEY`   | yes              | Bearer token the api presents to the data-provider     |
| `LOG_ID_PEPPER`         | yes              | Pepper for log-id hashing                              |
| `SENTRY_DSN`            | no               | Backend Sentry DSN; no DSN ⇒ SDK is a no-op            |

### `apps/backend/worker`

Same DB / Redis / Sentry / cloud-URL set as the api; plus shares
`ENCRYPTION_KEY` for credential decryption.

### `apps/backend/data-provider`

| Variable                | Required in prod | Purpose                                                |
| ----------------------- | ---------------- | ------------------------------------------------------ |
| `DATABASE_URL`          | yes              | Postgres connection                                    |
| `DATA_PROVIDER_API_KEY` | yes              | Bearer the api + worker must present                   |

### `apps/frontend/app`

| Variable             | Required in prod | Purpose                                  |
| -------------------- | ---------------- | ---------------------------------------- |
| `VITE_BACKEND_URL`   | yes              | Browser-visible api origin               |
| `VITE_SENTRY_DSN`    | no               | Frontend Sentry DSN; no DSN ⇒ SDK no-op  |

## Package-level

Apps that depend on a package **do not redeclare** that package's env vars
in their own schema. The package owns validation; the app just sets the
env var and trusts the package's loader.

### `@scani/security` — credential encryption

| Variable          | Required in prod | Purpose                                                       |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `ENCRYPTION_KEY`  | yes              | 32 hex chars; **must match between api and worker**           |

Refuses to start in production without a key. Used to AES-256-GCM encrypt
per-user provider credentials at rest.

### `@scani/storage` — object storage

| Variable               | Required in prod | Purpose                                       |
| ---------------------- | ---------------- | --------------------------------------------- |
| `S3_ENDPOINT`          | yes              | S3-compatible endpoint URL                    |
| `S3_REGION`            | yes              | Region (any string; some providers ignore it) |
| `S3_BUCKET`            | yes              | Bucket name                                   |
| `S3_ACCESS_KEY_ID`     | yes              | Access key                                    |
| `S3_SECRET_ACCESS_KEY` | yes              | Secret key                                    |

### `@scani/email` — email transport

Either Fastmail JMAP **or** SMTP — set one block, not both.

| Variable               | Required in prod | Purpose                                  |
| ---------------------- | ---------------- | ---------------------------------------- |
| `FASTMAIL_API_TOKEN`   | conditional      | Fastmail JMAP delivery                   |
| `SMTP_URL`             | conditional      | SMTP server URL                          |
| `SMTP_FROM`            | conditional      | From: address for outbound mail          |

## Provider integration keys

Optional. Each one unlocks specific functionality. The corresponding tRPC
router returns a `PRECONDITION_FAILED` error at call-time if unset.

| Variable                                                                                  | Unlocks                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `COINGECKO_API_KEY`                                                                       | CoinGecko pricing                      |
| `FINNHUB_API_KEY`                                                                         | Finnhub pricing                        |
| `OPENAI_API_KEY`                                                                          | Screenshot parsing                     |
| `PERPLEXITY_API_KEY`, `DEEPSEEK_API_KEY`                                                  | Token-identity backfill                |
| `ETHERSCAN_API_KEY`                                                                       | EVM wallet balances (all EVM chains)   |
| `HELIUS_API_KEY`                                                                          | Solana balances                        |
| `BINANCE_OAUTH_CLIENT_ID` / `BINANCE_OAUTH_CLIENT_SECRET` / `BINANCE_OAUTH_REDIRECT_URI`  | Binance OAuth exchange connection      |
