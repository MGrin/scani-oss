---
title: Tier model
description: The three deployment tiers Scani supports, and how to pick between them.
---

The same binaries run three ways. You pick by setting env vars — no feature
flags, no code-level switches.

| Tier                     | Data-provider runs on                                            | Use case                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **1 — Fully self-hosted**| The same machine as the rest of the stack (`bun run dev:stack`)  | You run everything; ideal for personal use or operators who want full control                                                  |
| **2 — Semi-managed**     | A hosted data-provider you point at                              | You run the api + worker + frontend; a hosted endpoint provides centralized 3rd-party access without you managing the keys    |
| **3 — Fully managed**    | A fully hosted deployment                                        | Someone else runs the whole stack for you                                                                                      |

## The two env vars that switch tiers

- `SCANI_CLOUD_URL` — where to send outbound 3rd-party requests
  (`http://data-provider:8082` for Tier 1; a hosted endpoint for Tier 2/3).
- `SCANI_CLOUD_API_KEY` — the bearer token the api + worker present.

That's it. Nothing else changes between tiers — same code, same containers,
same database schema.

## Where credentials live

- **User exchange / brokerage API keys** stay on the api in every tier — they
  never cross the tenant boundary. The api owns its own Postgres rows for
  per-user credentialed integrations.
- **Provider API keys** (CoinGecko, OpenAI, Etherscan, …) live wherever the
  data-provider runs. In Tier 1 that's your own machine; in Tier 2/3 it's
  whoever operates the hosted data-provider.

## Picking a tier

- **Personal use, full control, no monthly bill** → Tier 1.
- **Don't want to manage provider keys, OK trusting a hosted endpoint with
  outbound requests** → Tier 2.
- **Don't want to operate anything** → Tier 3.

The flow is one-way: anything you build on Tier 1 ports to Tier 2/3 with a
config change, because the only thing that moves is the data-provider URL.
