---
title: Tier model
description: Same binaries, three deployment shapes. Two env vars decide which tier you're on.
sidebar:
  order: 1
---

## Summary

The same set of binaries (`api`, `worker`, `data-provider`,
`frontend-app`) runs three ways. You decide by setting two
environment variables — there are no per-tier feature flags and no
per-tier code paths.

| Tier | `SCANI_CLOUD_URL` points at | Who runs it |
|---|---|---|
| **1 — fully self-hosted** | `http://data-provider:8082` on your own compose network. | You. |
| **2 — semi-managed** | A hosted `data-provider` endpoint. | You run api + worker + frontend; someone else runs the data-provider. |
| **3 — fully managed** | A hosted `data-provider` endpoint. | Someone else runs everything. |

The full design rationale is in
[Why the three-tier deployment model](/decisions/three-tier-model/).

## Choosing your tier

| Pick Tier 1 if… | Pick Tier 2 if… | Pick Tier 3 if… |
|---|---|---|
| You want full control of every byte. | You want to skip managing provider API keys (CoinGecko, OpenAI, Etherscan). | You want zero operational burden. |
| You don't want any traffic leaving your network. | You're fine sending price/AI/RPC queries to a hosted provider. | You're fine outsourcing the whole stack. |
| You enjoy ops work, or your environment requires it. | You're an operator running Scani for a small group of users. | You're a single user who wants the easy mode. |

## The two env vars

```sh
# Tier 1 — defaults from .env.example
SCANI_CLOUD_URL=http://localhost:8082
SCANI_CLOUD_API_KEY=dev_data_provider_key_change_me_not_prod_safe
DATA_PROVIDER_API_KEY=dev_data_provider_key_change_me_not_prod_safe

# Tier 2 — point api + worker at a hosted endpoint
SCANI_CLOUD_URL=https://data-provider.your-host.example.com
SCANI_CLOUD_API_KEY=<issued by the operator>
# DATA_PROVIDER_API_KEY is not used on the user side in Tier 2 — it
# lives on the hosted data-provider.
```

The data-provider validates incoming bearers against its own
`DATA_PROVIDER_API_KEY`. In Tier 1, single-tenant mode, it's the
same string as `SCANI_CLOUD_API_KEY`. In Tier 2+, the hosted
data-provider mints per-user / per-deployment keys via its
cloud-management surface (gated behind `CLOUD_MANAGEMENT_ENABLED=true`).

## What does NOT change between tiers

- **User integration credentials** (exchange API keys, brokerage
  tokens) always live on **your** `api`. Tier-2 operators do not
  see them.
- **The schema.** Same Postgres tables, same indexes, same
  migrations.
- **The wire contract.** tRPC routes, payload shapes, return types
  are identical across tiers.
- **The product behaviour.** No feature is gated by tier.

## What changes

| Concern | Tier 1 | Tier 2 / 3 |
|---|---|---|
| Outbound calls to CoinGecko / OpenAI / Etherscan / Helius / DeFiLlama / Finnhub / SMTP | Made by **your** data-provider. | Made by the **hosted** data-provider. |
| Provider API keys (CoinGecko, OpenAI, Etherscan, …) | You set them in your `.env`. | Operator sets them on their data-provider. |
| Public-internet attack surface | `frontend-app` only (api/worker/data-provider are internal). | `frontend-app` only on your side. Hosted data-provider has its own. |
| `SCANI_CLOUD_API_KEY` rotation | You rotate it; you also bump `DATA_PROVIDER_API_KEY` to match. | Operator rotates and ships you the new value. |

## Where to go next

- [Tier 1 — Local dev stack](/self-hosting/tier1/local-dev/) — the
  one-command path.
- [Tier 1 — Production with docker-compose](/self-hosting/tier1/production/)
  — the production-shaped compose file.
- [Tier 1 — Required environment variables](/self-hosting/tier1/required-env/)
  — the must-set list.
- [Tier 2 — Overview](/self-hosting/tier2/overview/) — what a hosted
  data-provider gives you.
- [Tier 3 — Fully managed](/self-hosting/tier3/) — the pointer page.

## See also

- [Why the three-tier deployment model](/decisions/three-tier-model/)
- [Environment variables reference](/reference/environment/)
