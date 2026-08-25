---
title: Tier 2 overview
description: Run the api, worker, and SPA on your hardware and let a hosted data-provider serve object storage, email, OG metadata and token search. Provider API keys stay on your side.
sidebar:
  order: 1
---

## Summary

**Tier 2** is the same self-hosted stack as
[Tier 1](/self-hosting/tier1/local-dev/), with one difference: the
`data-provider` is **not on your machine**. Instead, your api and
worker point at a hosted endpoint.

You still run:

- `api` (owns user integration credentials).
- `worker` (consumes BullMQ jobs).
- `frontend-app` (the SPA + nginx).
- Postgres, Redis, S3-compatible storage.

You **don't** run the data-provider container.

## You still need your provider API keys

:::danger
Pointing `SCANI_CLOUD_URL` at a hosted data-provider moves **four**
things off your machine: object storage, email, OG-metadata fetching
and token search. It does **not** move pricing, AI or chain calls.

Your api and worker boot the provider registry in `direct` mode on
every tier and call CoinGecko, DeFiLlama, Frankfurter, Finnhub,
Etherscan, Helius and OpenAI themselves. So
`COINGECKO_API_KEY`, `FINNHUB_API_KEY`, `ETHERSCAN_API_KEY`,
`HELIUS_API_KEY`, `OPENAI_API_KEY` and the `GOOGLE_*` pair must be set
on the **api and worker**, whichever tier you run.

Leaving them off degrades **silently** rather than failing at boot —
see [What happens without them](#what-happens-without-them).
:::

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
`SCANI_CLOUD_API_KEY` to actually call any route — sign in at
[cloud.scani.xyz](https://cloud.scani.xyz) to mint one.

Operators running their own hosted data-provider can swap the URL for
their own — the contract is identical.

:::caution[A minted Cloud API key does not reach storage or email]
Object storage and email on a hosted data-provider are internal facades
over that operator's own bucket and mail account, not a product surface:
object keys carry no tenant prefix, so a key that can read one object can
read every deployment's. They answer `403 FORBIDDEN` to any bearer that is
not the operator's own (SC-585).

A key minted through the cloud console is therefore **not** enough for
Tier 2 storage and email. Two ways forward, and the operator picks:

- Keep your own `S3_*` and `SMTP_*`, and use the hosted data-provider for
  pricing, AI, chain reads, OG metadata and token search.
- Have the operator grant your key explicitly, by setting its
  `cloud_api_keys.tier` to `internal`. No endpoint can do this — it is a
  direct write, deliberately — and it should only be done for a key that
  is trusted with **every object in that bucket**.

`scani_sk_…` keys minted at [cloud.scani.xyz](https://cloud.scani.xyz)
are not granted, and Scani does not grant them.
:::

## When Tier 2 makes sense

| Pick Tier 2 when… | Stay on Tier 1 when… |
|---|---|
| You don't want to run an S3 bucket and an email transport yourself. | You want zero outbound traffic that didn't originate from your network. |
| You're a small operator and consolidating storage + mail makes sense. | You already have a bucket and an SMTP server. |
| You'd rather not operate a fourth container. | You want the strongest privacy posture. |

Note what is **not** on that list: Tier 2 is not a way to avoid
managing provider API keys — see
[above](#you-still-need-your-provider-api-keys).

## What stays on your side

| Concern | Lives on |
|---|---|
| Holdings, transactions, prices, observations | Your Postgres. |
| Sessions, users, vaults, groups | Your Postgres. |
| Encrypted integration credentials (exchange keys, brokerage tokens) | Your Postgres, AES-256-GCM-encrypted with your `ENCRYPTION_KEY`. |
| BullMQ job state, sync schedules | Your Postgres, in the `bullmq` schema. |
| Rate-limiter buckets, realtime pub/sub | Your Redis. |
| **Provider API keys** (CoinGecko, Finnhub, Etherscan, Helius, OpenAI) | **Your `.env`, read by your api and worker.** |
| **Outbound pricing, AI and chain calls** | **Your api and worker, direct to upstream.** |
| Logs | Your stdout / log aggregator. |

## What's hosted

| Concern | Lives on |
|---|---|
| Object storage (uploaded screenshots, file imports) | Hosted data-provider's bucket. |
| Email transport (Fastmail JMAP or SMTP) | Hosted data-provider. |
| Open Graph metadata fetching (institution logos) | Hosted data-provider. |
| Token search (symbol → identity lookup) | Hosted data-provider. |

Those four are the whole list, and they are the whole list because
they are the only adapters `packages/clients/cloud-client/src/` has:
`cloud-storage.ts`, `cloud-email-service.ts`, `cloud-og-client.ts`,
and the `tokens.search` call in
`packages/business/domain/src/services/tokens/TokenValidationService.ts`.

The hosted data-provider sees only those four kinds of request. User
accounts are not visible to it; user credentials never leave your
`api`.

## What happens without them

None of the keyless branches throws at boot, so a stack with no
provider keys comes up **green on every health check** and then
returns bad data. What each missing key costs:

| Unset | Provider | What it does instead |
|---|---|---|
| `COINGECKO_API_KEY` | CoinGecko | Drops to the public rate-limited tier instead of the Pro host. |
| `FINNHUB_API_KEY` | Finnhub | Returns null for every call — indistinguishable from "no price known". |
| `ETHERSCAN_API_KEY` | Etherscan | Calls go out unauthenticated, sharing the anonymous free-tier budget. |
| `HELIUS_API_KEY` | Solana | Falls back to the public Solana RPC, which throttles aggressively. |
| `OPENAI_API_KEY` | OpenAI | Throws on every call, so screenshot and document parsing fail. |

### How to check, rather than guess

Every one of those five reports its status at boot, and the registry
emits **one summary line whether or not anything is degraded**:

```sh
docker compose -f docker-compose.prod.yml logs api worker \
  | grep 'provider credentials:'
```

Production logs are JSON (`LOG_PRETTY` is forced off when
`NODE_ENV=production`), so the line arrives as a `msg` field:

```
{… "mode":"direct","msg":"✅ provider credentials: 5/5 keyed · keyed: coingecko, etherscan, finnhub, openai, solana · degraded: none"}

{… "degraded":["COINGECKO_API_KEY","OPENAI_API_KEY"],"mode":"direct","msg":"⚠️  provider credentials: 3/5 keyed · keyed: etherscan, finnhub, solana · degraded: coingecko [COINGECKO_API_KEY unset → drops to the public rate-limited tier instead of the Pro host]; openai [OPENAI_API_KEY unset → throws on every call, so screenshot and document parsing fail]"}
```

The degraded line also carries a `degraded` array of just the unset
variable names, which is the cheaper thing to alert on.

The healthy line prints too, so its **absence** is a signal — a
provider quietly dropping out of the keyed set is visible as a change
rather than as silence.

The api serves the same record over HTTP:

```sh
docker compose -f docker-compose.prod.yml exec api \
  curl -fsS http://localhost:3001/health/deep | jq .providerCredentials
```

```json
{
  "keyed": ["coingecko", "etherscan", "finnhub", "solana"],
  "degraded": [
    { "provider": "openai", "envVar": "OPENAI_API_KEY",
      "behaviour": "throws on every call, so screenshot and document parsing fail" }
  ]
}
```

A degraded provider deliberately does **not** turn `/health/deep`
red: an unkeyed provider is a configuration choice, not an outage,
and an endpoint that is always red is one nobody reads. The worker
has no HTTP health endpoint — for the worker, the boot line above is
the signal.

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
   **Keep your provider keys where they are.**
3. Comment out (or remove) the `data-provider` service block in
   your `docker-compose.prod.yml`.
4. Recreate api + worker:
   ```sh
   docker compose -f docker-compose.prod.yml up -d api worker
   ```
5. Your sync schedules and history are intact. What changes is where
   storage, email, OG metadata and token search go.

See [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/) for
the step-by-step, including rolling back if the migration doesn't
work out.

## Trust model

- **Your data-provider operator can read every request you send
  them.** That is uploads and downloads through their bucket, the
  bodies of the emails you send, the URLs you fetch OG metadata for,
  and the symbols you search. They cannot read your user accounts,
  balances, or integration credentials — those never leave your api.
- **They hold your object storage.** Uploaded screenshots and
  imported statement files live in their bucket, not yours.
- **You trust them to maintain availability.** If their endpoint is
  down, uploads, magic-link email and token search fail (BullMQ will
  retry per the retry policy in
  `packages/business/jobs/src/retry-policies.ts`). Pricing and chain
  syncs are unaffected, because they never went there.

## See also

- [Pointing api + worker at a hosted endpoint](/self-hosting/tier2/wiring/)
- [What stays on your side](/self-hosting/tier2/user-creds/)
- [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/)
- [Tier model](/self-hosting/tier-model/)
- [Why the three-tier deployment model](/decisions/three-tier-model/)
