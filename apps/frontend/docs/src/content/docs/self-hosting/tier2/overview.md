---
title: Tier 2 overview
description: Run the api, worker, and SPA on your hardware; let a hosted data-provider handle provider API keys and outbound third-party calls.
sidebar:
  order: 1
---

## Summary

**Tier 2** is the same self-hosted stack as
[Tier 1](/self-hosting/tier1/local-dev/), with one difference: the
`data-provider` is **not on your machine**. Instead, your api and
worker point at a hosted endpoint that handles every outbound
third-party call (CoinGecko, OpenAI, Etherscan, Helius, …) on your
behalf.

You still run:

- `api` (owns user integration credentials).
- `worker` (consumes BullMQ jobs).
- `frontend-app` (the SPA + nginx).
- Postgres, Redis, S3-compatible storage.

You **don't** run the data-provider, and you **don't** need any of
the provider API keys (`COINGECKO_API_KEY`, `OPENAI_API_KEY`,
`ETHERSCAN_API_KEY`, `HELIUS_API_KEY`, `FINNHUB_API_KEY`, …).

## The hosted endpoint

The official Scani Cloud data-provider is:

```
https://api.cloud.scani.xyz
```

Smoke-test it before pointing your api/worker at it:

```sh
curl -fsS https://api.cloud.scani.xyz/health
# {"status":"ok","timestamp":"…","version":"1.0.0"}
```

A successful `200` with a JSON body means the endpoint is reachable
from your network and the TLS chain validates. You still need an
`SCANI_CLOUD_API_KEY` to actually call any provider route — sign in
at [cloud.scani.xyz](https://cloud.scani.xyz) to mint one.

Operators running their own hosted data-provider can swap the URL for
their own — the contract is identical.

## When Tier 2 makes sense

| Pick Tier 2 when… | Stay on Tier 1 when… |
|---|---|
| You don't want to manage provider keys. | You want zero outbound traffic that didn't originate from your network. |
| You're a small operator running Scani for a handful of users and consolidating provider costs makes sense. | You're running for yourself or a small team that already has the keys. |
| You want the convenience of "it just works" pricing/AI/RPC. | You want the strongest privacy posture. |

## What stays on your side

| Concern | Lives on |
|---|---|
| Holdings, transactions, prices, observations | Your Postgres. |
| Sessions, users, vaults, groups | Your Postgres. |
| Encrypted integration credentials (exchange keys, brokerage tokens) | Your Postgres, AES-256-GCM-encrypted with your `ENCRYPTION_KEY`. |
| Uploaded screenshots / file imports | Your S3 bucket. |
| BullMQ job state, sync schedules | Your Redis. |
| Logs | Your stdout / log aggregator. |

The hosted data-provider sees **only** the requests api/worker
make to it: queries like "current BTC price", "Etherscan transactions
for 0xabc…", "OpenAI parse this screenshot". User accounts are not
visible to the hosted data-provider; user credentials never leave
your `api`.

## What's hosted

| Concern | Lives on |
|---|---|
| Provider API keys (CoinGecko, OpenAI, Etherscan, Helius, Finnhub, DeFiLlama) | Hosted data-provider. |
| Outbound HTTP to upstream providers | Hosted data-provider. |
| Email transport (Fastmail JMAP or SMTP) | Hosted data-provider. |

Email is hosted in Tier 2 because the data-provider owns the
`email.send` tRPC route — your api enqueues `screenshot-parse` and
the data-provider does the OpenAI call; your api requests a
magic-link email and the data-provider does the SMTP send.

## How to switch from Tier 1 to Tier 2

1. Provision (or obtain) a hosted data-provider endpoint. The
   official endpoint is `https://api.cloud.scani.xyz`; mint an API
   key at [cloud.scani.xyz](https://cloud.scani.xyz). (Operators
   running their own hosted data-provider use their own URL.)
2. Update `.env`:
   ```ini
   SCANI_CLOUD_URL=https://api.cloud.scani.xyz
   SCANI_CLOUD_API_KEY=<the issued key>
   ```
3. Comment out (or remove) the `data-provider` service block in
   your `docker-compose.prod.yml`.
4. Recreate api + worker:
   ```sh
   docker compose -f docker-compose.prod.yml up -d api worker
   ```
5. Your sync schedules and history are intact. The only thing that
   changes is *where* outbound calls go.

See [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/) for
the step-by-step, including rolling back if the migration doesn't
work out.

## Trust model

- **Your data-provider operator can read every query you send them.**
  That includes which wallets you're looking up on Etherscan, which
  screenshots you upload for OpenAI parsing, which pricing pairs
  you're requesting. They cannot read your user accounts, balances,
  or integration credentials — those never leave your api.
- **You trust the operator to keep their provider keys safe and
  funded.** If their CoinGecko key gets rate-limited, your prices
  go stale.
- **You trust them to maintain availability.** If their endpoint is
  down, your worker's sync jobs will fail (BullMQ will retry per
  the retry policy in `packages/business/jobs/src/retry-policies.ts`).

## See also

- [Pointing api + worker at a hosted endpoint](/self-hosting/tier2/wiring/)
- [What stays on your side](/self-hosting/tier2/user-creds/)
- [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/)
- [Tier model](/self-hosting/tier-model/)
- [Why the three-tier deployment model](/decisions/three-tier-model/)
