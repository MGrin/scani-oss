---
title: Why the three-tier deployment model
description: One binary set, three deployment shapes. Two env vars switch tiers. The seam is the data-provider, so user credentials never have to cross a tenant boundary.
sidebar:
  order: 6
---

## The decision

Scani ships **one** set of binaries (`api`, `worker`, `data-provider`,
`frontend-app`) that runs in three shapes:

- **Tier 1 — fully self-hosted.** Everything on your hardware,
  including the `data-provider`.
- **Tier 2 — semi-managed.** `api` + `worker` + `frontend-app` on your
  side; `data-provider` provided by a hosted endpoint.
- **Tier 3 — fully managed.** Someone else runs the whole stack.

Two environment variables switch tiers:

- `SCANI_CLOUD_URL` — where to send outbound third-party calls.
- `SCANI_CLOUD_API_KEY` — the bearer the api + worker present.

## The alternative we rejected

Per-tier forks of the codebase: a self-host build, a managed-service
build, a SaaS build. Each with its own auth model, its own deployment
shape, its own feature set.

## Why we rejected it

**Forks rot.** Three codebases means three places to land every
feature, three places to fix every bug, three CI matrices, three
chances for security findings to apply to two of three forks. The
team is small. The fork tax is unaffordable.

**The natural seam already existed.** Every third-party call (pricing,
AI, blockchain RPC, email) was already centralised on the
`data-provider` service for testability and rate-limit isolation.
Once the seam is named, the tier choice is just "which endpoint do
api + worker call?". No fork required.

**User credentials must stay on the user's side.** Exchange API keys,
brokerage tokens, screenshot blobs — these are sensitive. They live
on the `api`, which the user controls (Tier 1) or which their
operator runs (Tier 2). The `data-provider` only sees the queries
that don't carry user secrets (current BTC price, fetched today's
ETH/USD candle). The tier seam is *also* the credential boundary:
nothing on the user side gets sent to a hosted `data-provider` that
the user didn't already plan to publish.

## What the three tiers look like

| Aspect | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| `api` runs… | On your hardware. | On your hardware. | Hosted. |
| `worker` runs… | On your hardware. | On your hardware. | Hosted. |
| `data-provider` runs… | On your hardware. | Hosted endpoint. | Hosted endpoint. |
| User integration creds (exchange keys, brokerage tokens) | On your `api`. | On your `api`. | Hosted. |
| Provider keys (CoinGecko, OpenAI, Etherscan) | You set them on your `data-provider`. | Operator sets them on the hosted `data-provider`. | Operator sets them on the hosted `data-provider`. |
| What's reachable from the public internet | Just `frontend-app`. | Just `frontend-app`. | All hosted. |

## What this design unlocks

- **One codebase, three deployment shapes.** Every PR ships to all
  three tiers simultaneously.
- **The Tier-1→Tier-2 migration is a config change.** Re-point
  `SCANI_CLOUD_URL` at the hosted endpoint; provide the issued
  `SCANI_CLOUD_API_KEY`; restart api + worker. Your data stays on
  your side; only the upstream provider calls fan out from
  someone else.
- **Provider keys are centralised when you want them centralised.**
  A small operator running 50 users doesn't need each user to bring
  their own OpenAI key.
- **Air-gapped Tier 1 is real.** Without `SCANI_CLOUD_URL` pointing
  at any hosted service, the local `data-provider` is the *only*
  outbound call. The OSS distribution sends no telemetry.

## What the design costs

- **The `data-provider` is a separate service to run.** In Tier 1 it
  is a sidecar on the same compose network; the operational cost is
  trivial.
- **Two env vars have to match.** `SCANI_CLOUD_API_KEY` on api +
  worker must equal `DATA_PROVIDER_API_KEY` on the data-provider.
  In Tier 1 single-tenant, both are seeded with the same value in
  `.env.example`.

## What this rules out

- A "merge the api and the data-provider for Tier 1 only" shortcut.
  The whole point of the seam is that *it doesn't go away in any
  tier* — that's what makes the contract testable end-to-end.
- Per-tier feature flags that change product behaviour. The product
  is the same; only the deployment shape differs.

## See also

- [Tier model](/self-hosting/tier-model/)
- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Privacy & telemetry](/start/what-is-scani/#license--telemetry)
- [Glossary: tier](/reference/glossary/#tier)
