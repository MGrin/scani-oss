---
title: What stays on your side
description: User integration credentials (exchange API keys, brokerage tokens, screenshots) never leave the api. The tier seam is the credential boundary.
sidebar:
  order: 3
---

## The principle

The data-provider seam is **also** the credential boundary. In Tier
2, sensitive user data stays on your api; only the third-party
queries that need a provider key are forwarded to the hosted
data-provider.

## What never leaves your side

| Data | Stored where | Visible to hosted data-provider |
|---|---|---|
| User accounts, sessions | Your Postgres. | No. |
| User integration credentials (Binance API key, IBKR Flex token, Wise token, …) | Your Postgres, AES-256-GCM-encrypted with your `ENCRYPTION_KEY`. | No. |
| Holdings, transactions, observations, prices, portfolio rollup | Your Postgres. | No. |
| Vaults, groups, APY configs | Your Postgres. | No. |
| Uploaded screenshots / file imports | Your S3 bucket. | The **image** is sent to the data-provider for parsing; the user identity behind it is not. |

## What the data-provider does see

Per outbound call:

- **The query itself.** `"get current BTC/USD price"`, `"fetch
  Etherscan transactions for 0xabc..."`, `"parse this screenshot
  image"`.
- **No session, no user ID**, except as opaque correlation IDs the
  data-provider uses for its own rate-limiting and logging.
- **No exchange API keys.** When the api's exchange-sync code runs,
  it decrypts the user's stored API key on **your** machine, makes
  the call to (e.g.) Binance through the data-provider acting as a
  rate-limited proxy, but the call itself carries the user's key
  in headers — those headers never enter the data-provider's
  storage; they pass through to upstream and are dropped.

The implementation lives in `apps/backend/data-provider/src/presentation/`
— every router strips request/response payloads to the minimum
needed to serve the upstream call.

## Why this matters in Tier 2

Tier 2 means trusting an operator to run a data-provider. That trust
is bounded to:

- They keep their provider keys safe and funded.
- They don't log query payloads beyond what they need to operate.
- They keep the service available.

The trust does **not** extend to "they can read every Binance trade
you make" — the only way they'd see that is by reading the rotating
Binance API request payloads as they pass through, which is a
detectable abuse (TLS interception or modified data-provider code)
not a feature.

## Encryption of integration creds

Integration credentials are encrypted with `ENCRYPTION_KEY` (32 hex
chars, AES-256-GCM with scrypt-derived nonces). The key lives in
your `.env`; it is **not** sent to the data-provider.

`packages/infra/security/src/config.ts` enforces:

- 32 hex chars exactly (validates at startup).
- Required in production. Boot fails without it.

If you lose the key, the encrypted credentials are unrecoverable.
See [Backup & restore](/self-hosting/tier1/backup-restore/) for
the operational implications.

## Screenshots

Screenshot parsing is the one place where user-uploaded *content*
crosses to the data-provider — the screenshot image itself is sent
to OpenAI Vision via the data-provider as a transparent proxy.

Operational notes:

- The image bytes are passed through; the data-provider does not
  store them. (Your S3 bucket holds the durable copy.)
- The user identity is not attached; the data-provider only sees
  "parse this image" with an opaque request ID.
- If you don't want any screenshots leaving your machine, don't
  configure `OPENAI_API_KEY` (operator-side) or unset the
  screenshot-parse capability. The user-facing import flow
  degrades gracefully (`PRECONDITION_FAILED`).

## See also

- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
