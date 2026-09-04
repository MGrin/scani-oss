---
title: What stays on your side
description: User integration credentials never leave the api, and your provider API keys never leave your api and worker either. What the hosted data-provider does and does not see.
sidebar:
  order: 3
---

## The principle

The data-provider seam is **also** the credential boundary. In Tier
2, sensitive user data stays on your api; four narrow capabilities —
object storage, email, OG-metadata fetching and token search — are
served by the hosted data-provider.

Everything else, including every call that needs a provider API key,
is made by your own api and worker. Those keys stay in your `.env`;
see [You still need your provider API
keys](/self-hosting/tier2/overview/#you-still-need-your-provider-api-keys).

## What never leaves your side

| Data | Stored where | Visible to hosted data-provider |
|---|---|---|
| User accounts, sessions | Your Postgres. | No. |
| User integration credentials (Binance API key, IBKR Flex token, Wise token, …) | Your Postgres, AES-256-GCM-encrypted with your `ENCRYPTION_KEY`. | No. |
| Holdings, transactions, observations, prices, portfolio rollup | Your Postgres. | No. |
| Vaults, groups, APY configs | Your Postgres. | No. |

**Uploaded screenshots and statement files are the one exception to
this page's title.** Object storage is one of the four capabilities
Tier 2 moves, so those bytes live in the **operator's** bucket, not
yours. What the file *yielded* — the extracted holdings and
transactions — is rows in your Postgres and stays there. On Tier 1
the bucket is yours too and nothing about a file leaves.

## What the data-provider does see

Only the four capabilities it serves:

- **Object storage.** Presigned upload/download URLs and direct
  read/write/copy/delete. In Tier 2 the operator's bucket holds the
  durable copy of every uploaded screenshot and statement file.
- **Email.** The rendered message — recipient, subject, body — for
  every magic-link, OTP and verification mail your api sends.
- **Open Graph metadata.** The URLs your api fetches institution
  logos and titles from.
- **Token search.** The symbols users type when adding a holding.

Each carries **no session and no user ID**, except as opaque
correlation IDs the data-provider uses for its own rate-limiting and
logging.

## What the data-provider does not see

- **Pricing, AI and chain queries.** Your api and worker call
  CoinGecko, DeFiLlama, Frankfurter, Finnhub, Etherscan, Helius and
  OpenAI **directly**, with your keys, on every tier. The hosted
  data-provider is not in that path and cannot observe it.
- **Exchange and brokerage traffic.** Binance, Kraken, Bybit, OKX,
  Coinbase, IBKR, Wise and the rest are user-credentialed providers
  registered only in your api and worker. Your api decrypts the
  user's stored key on **your** machine and calls the venue itself —
  nothing about that request reaches the data-provider.

The implementation lives in `apps/backend/data-provider/src/presentation/`
— every router strips request/response payloads to the minimum
needed to serve the upstream call.

## Why this matters in Tier 2

Tier 2 means trusting an operator to run a data-provider. That trust
is bounded to:

- They hold your object storage — every uploaded screenshot and
  imported statement file.
- They can read the emails your api sends.
- They don't log query payloads beyond what they need to operate.
- They keep the service available.

The trust does **not** extend to "they can read every Binance trade
you make", and not because payloads are stripped: exchange calls are
made by your api and never reach them at all. The same is true of
every pricing, AI and chain call — those are made with **your**
provider keys, from **your** machine.

## Encryption of integration creds

Integration credentials are encrypted with `ENCRYPTION_KEY` (≥32
chars, AES-256-GCM; a 64-hex-char value is used directly, any other
≥32-char string is run through scrypt). The key lives in your
`.env`; it is **not** sent to the data-provider.

`packages/infra/security/src/config.ts` enforces:

- At least 32 chars (validates at startup).
- Required in production. Boot fails without it.

If you lose the key, the encrypted credentials are unrecoverable.
See [Backup & restore](/self-hosting/tier1/backup-restore/) for
the operational implications.

## Screenshots

A screenshot import touches two external parties, and they are
different ones:

1. **The operator's bucket.** The upload is presigned by, and lands
   in, the hosted data-provider's object storage. The operator holds
   the durable copy.
2. **OpenAI, directly from your worker.** The worker reads the image
   back out of storage and calls OpenAI Vision itself, with **your**
   `OPENAI_API_KEY`. The data-provider is not in this hop and never
   sees the parse request.

If you don't want screenshots leaving your machine, the lever is on
**your** side, not the operator's: unset `OPENAI_API_KEY` in your own
`.env`. The screenshot-parse job then fails on every attempt (the
OpenAI provider throws without a key) rather than degrading quietly.
Note that this stops the *parsing*, not the *upload* — the image is
already in the operator's bucket by then. In Tier 1 the bucket is
yours too: you run the whole stack, database and object storage
included. Pricing and any integrations you enable still call out to
their providers.

## See also

- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
