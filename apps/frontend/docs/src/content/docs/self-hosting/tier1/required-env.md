---
title: Required environment variables
description: The must-set environment variables for any Scani deployment. Booting without them is a hard failure.
sidebar:
  order: 3
---

These are the variables every Scani deployment must set. Optional
integration keys live on the
[next page](/self-hosting/tier1/optional-keys/); the full annotated
list lives in [`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example)
and is enumerated in the [Environment variables reference](/reference/environment/).

## Core

| Variable | What it does | How to generate |
|---|---|---|
| `NODE_ENV` | `production` for any real deployment. | Set to `production`. |
| `DATABASE_URL` | Postgres 16+ connection string. SSL mode required for non-localhost. | Provided by your Postgres host. |
| `REDIS_URL` | Redis 7+ connection string. Powers BullMQ, the rate-limiter, and pub/sub. | Provided by your Redis host. |
| `POSTGRES_POOL_MAX` | Per-app pool size. Default 20 for direct endpoints; **set to 5** if your URL routes through PgBouncer or another connection pooler. | Set explicitly when using a pooler. |

## Auth & secrets

| Variable | What it does | How to generate |
|---|---|---|
| `BETTER_AUTH_SECRET` | 32+ chars. Better-Auth session signing key. Rotating it invalidates every active session. | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | **Exactly 32 hex chars**. AES-256-GCM key that encrypts integration credentials at rest. **Must match between api and worker** — if they differ, the worker cannot decrypt what the api stored and every import silently fails. | `openssl rand -hex 16` |
| `JOBS_HMAC_SECRET` | 32+ chars. Shared secret for HMAC-gated operator tooling (BullMQ retry/remove, DLQ replay). | `openssl rand -hex 32` |
| `SCREENSHOT_BOT_SECRET` | 32+ chars. Bearer for the `screenshot-bot/sign-in` endpoint. Required in production; optional in dev. | `openssl rand -hex 32` |
| `LOG_ID_PEPPER` | 16+ chars. Pepper used to one-way hash user / tenant / account IDs in structured logs. **Production boot fails without it.** | `openssl rand -hex 32` |

## Public URLs

| Variable | What it does |
|---|---|
| `FRONTEND_URL` | The browser-facing URL of the SPA (e.g. `https://scani.example.com`). Used for CORS and the Better-Auth cookie scope. **Must be https://** in production. |
| `BACKEND_URL` | The browser-facing URL of the api (e.g. `https://api.scani.example.com` or `https://scani.example.com/api`). Embedded in magic-link emails — must be reachable by the user's email client. |
| `COOKIE_DOMAIN` | Set to `.your-domain.example.com` if api and SPA live on different subdomains. The session cookie is set with this domain so it reaches both. Leave unset if both share an origin. |

## Tier wiring

| Variable | What it does |
|---|---|
| `SCANI_CLOUD_URL` | Where the api + worker send outbound third-party calls. Tier 1: `http://data-provider:8082` (the same compose network). Tier 2/3: a hosted data-provider endpoint. |
| `SCANI_CLOUD_API_KEY` | Bearer the api + worker present to the data-provider. In Tier 1, matches `DATA_PROVIDER_API_KEY`. In Tier 2/3, issued by the operator. |
| `DATA_PROVIDER_API_KEY` | What the data-provider validates incoming bearers against. In Tier 1, equals `SCANI_CLOUD_API_KEY`. In Tier 2/3, lives on the hosted data-provider, not on your side. |

## Object storage

| Variable | What it does |
|---|---|
| `S3_ENDPOINT` | S3-compatible endpoint URL. Tier 1 in compose: `http://minio:9000`. Cloud providers: their endpoint. |
| `S3_PUBLIC_ENDPOINT` | What gets baked into presigned URLs the browser uses. Often the same as `S3_ENDPOINT` but differs for compose-internal MinIO (`http://localhost:9000` for the browser). |
| `S3_ACCESS_KEY_ID` | Provider-issued. |
| `S3_SECRET_ACCESS_KEY` | Provider-issued. |
| `S3_BUCKET` | Bucket name. Must exist; the `minio-init` service creates it for compose-managed MinIO. |

## Email

Pick one. Booting with neither configured fails on the first email send.

| Variable | What it does |
|---|---|
| `FASTMAIL_API_TOKEN` | Fastmail JMAP token. Takes precedence when set. |
| `SMTP_URL` | `smtp://user:pass@host:port` for any SMTP server. |
| `SMTP_FROM` | The from address for outbound mail. |

## Logging

| Variable | What it does |
|---|---|
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`. Default `info` in production. |
| `LOG_PRETTY` | Pretty-print logs. Default `false` in production. |
| `LOG_SQL_QUERIES` | Default `false`. Turn on briefly for debugging. |

## Sanity check

Before booting production:

```sh
# Read back every required-in-prod var
docker compose -f docker-compose.prod.yml config | grep -E '^(\s+)?(DATABASE_URL|REDIS_URL|BETTER_AUTH_SECRET|ENCRYPTION_KEY|JOBS_HMAC_SECRET|FRONTEND_URL|BACKEND_URL|SCANI_CLOUD_API_KEY|DATA_PROVIDER_API_KEY|LOG_ID_PEPPER):'

# A missing required var fails with a readable message
docker compose -f docker-compose.prod.yml up -d
```

## See also

- [Optional integration keys](/self-hosting/tier1/optional-keys/)
- [Production with docker-compose](/self-hosting/tier1/production/)
- [Environment variables reference](/reference/environment/)
