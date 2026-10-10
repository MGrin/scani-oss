---
title: Tier 2 — your data, cloud processing
description: Host your UI, API, worker, database and S3; use one Scani Cloud key for managed processing.
sidebar:
  order: 1
---

Tier 2 gives you control over durable data without requiring accounts and keys
for each platform data provider. You run the UI, API, worker, Postgres, Redis and
S3-compatible storage. Scani Cloud handles AI extraction, market prices, token
information, supported blockchain queries and authentication email.

## Credentials

The only external platform credential is `SCANI_CLOUD_API_KEY`, obtained from
[Scani Cloud](https://cloud.scani.xyz). Do not configure local `OPENAI_API_KEY`,
`COINGECKO_API_KEY`, `FINNHUB_API_KEY`, `ETHERSCAN_API_KEY`, `HELIUS_API_KEY`,
`GOOGLE_SERVICE_ACCOUNT_KEY` or `GOOGLE_SHEETS_ID` for Tier 2.

Local infrastructure secrets still exist. The installer generates database and
S3 passwords, the session secret and the credential-encryption key. Personal
exchange/broker credentials remain separate and stay in your local database.

## Data ownership

| Data | Durable home |
|---|---|
| Holdings, transactions, balances and saved prices | Your Postgres |
| Users, sessions, encrypted exchange/broker credentials | Your Postgres |
| Job state and schedules | Your Postgres |
| Uploaded screenshots, statements and icons | Your S3 |
| Cache and realtime coordination | Your Redis |

For processing, your worker reads a local file and sends its content to Scani
Cloud. Cloud returns a result; your worker validates and persists it locally.
Cloud never receives your database or S3 credentials. Your bucket does not need
to be publicly readable or reachable from Scani Cloud.

Processing requires data egress. Scani and the upstream processor see the inputs
necessary for the operation. The processing service does not log request bodies.
AI results may be retained in its Redis replay cache for five minutes to avoid
repeating paid work after a lost response. Usage records retain operational
metadata and counts, not documents. This does not promise a particular upstream
vendor retention policy.

## Supported cloud operations

The versioned `processing.v1` API provides AI, pricing and public-wallet
processing. Token search/identity and Open Graph requests use their existing
cloud endpoints. Bank connections through Salt Edge are planned and are not
part of this release.

Cloud pricing does not include Yahoo Finance, whose terms do not allow its data
to be redistributed. Stocks Finnhub cannot price, such as many non-US listings,
and currencies outside the central-bank feeds stay unpriced on Tier 2. Tier 1
prices them directly from your own instance.

Authentication mail uses fixed templates and a fixed Scani self-hosted sender,
identifying your instance's hostname. Use an HTTPS public application URL. Raw
`email.send` and all `storage.*` endpoints remain internal and return `403` for
customer keys. Never request an internal key to make Tier 2 work.

AI has a limit of 30 new operations per cloud account per hour; authentication
mail has 20 per account and 10 per recipient per hour, in addition to the normal
Cloud API quota. Identical successful operations are replayed for five minutes.
An in-progress operation or uncertain upstream failure blocks identical retries
for up to ten minutes, preventing duplicate paid processing.

## Cloud outages

Local records and files remain on your infrastructure. Cloud-dependent work
reports a failure and can be retried through your local job workflow. Tier 2
never silently switches to direct providers or cloud-owned storage.

Continue with [wiring](/self-hosting/tier2/wiring/) or
[migrating an existing install](/self-hosting/tier2/migration/).
