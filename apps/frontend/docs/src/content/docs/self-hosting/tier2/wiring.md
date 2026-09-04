---
title: Pointing api + worker at a hosted endpoint
description: The two env vars that switch the api and worker from a local data-provider to a hosted one — and the keys that stay put when you do.
sidebar:
  order: 2
---

## Two env vars

```ini
SCANI_CLOUD_URL=https://api.cloud.scani.xyz
SCANI_CLOUD_API_KEY=<bearer issued by the operator>
```

`SCANI_CLOUD_URL` replaces the Tier-1 default
`http://data-provider:8082` (the compose-network hostname). The
official Scani Cloud endpoint is `https://api.cloud.scani.xyz`;
operators running their own hosted data-provider use their own URL.

`SCANI_CLOUD_API_KEY` is the bearer the api and worker present in
the `Authorization` header on every tRPC call to the data-provider.
Mint one for `api.cloud.scani.xyz` at
[cloud.scani.xyz](https://cloud.scani.xyz); on a self-operated
endpoint the operator gives you one.

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

## Working `.env` snippet

A minimal Tier 2 `.env` adds these two vars and drops the ones that
belonged specifically to running your own data-provider container —
`DATA_PROVIDER_API_KEY`, the SMTP creds, the Fastmail token and
`S3_*`:

```ini
NODE_ENV=production
SCANI_CLOUD_URL=https://api.cloud.scani.xyz
SCANI_CLOUD_API_KEY=scani_sk_…   # from cloud.scani.xyz

# KEEP these. They are read by the api and worker on EVERY tier —
# see /self-hosting/tier2/overview/#you-still-need-your-provider-api-keys
COINGECKO_API_KEY=…
FINNHUB_API_KEY=…
ETHERSCAN_API_KEY=…
HELIUS_API_KEY=…
OPENAI_API_KEY=…

# Plus everything Tier 1 already required: DATABASE_URL, REDIS_URL,
# FRONTEND_URL, BACKEND_URL, ENCRYPTION_KEY, BETTER_AUTH_SECRET,
# JOBS_HMAC_SECRET. See /self-hosting/tier1/required-env/.
```

The provider keys are the ones people get wrong. `SCANI_CLOUD_URL`
moves object storage, email, OG-metadata fetching and token search to
the hosted data-provider. Pricing, AI and chain calls are still made
by your api and worker, which boot the provider registry in `direct`
mode on every tier — so removing those keys degrades your stack
silently.

Smoke-test the endpoint is reachable before bringing the stack up:

```sh
curl -fsS https://api.cloud.scani.xyz/health
# {"status":"ok","timestamp":"…","version":"1.0.0"}
```

The hosted data-provider validates the bearer against its own
`DATA_PROVIDER_API_KEY` (the variable the operator sets on their
side). You don't need `DATA_PROVIDER_API_KEY` on your side in Tier
2 — it lives on the operator's deployment.

## What changes

| Component | Tier 1 | Tier 2 |
|---|---|---|
| `data-provider` container | Yours, on the compose network. | Operator's, reachable via HTTPS. |
| `SCANI_CLOUD_URL` | `http://data-provider:8082` | `https://...` (operator-provided). |
| `SCANI_CLOUD_API_KEY` | Matches `DATA_PROVIDER_API_KEY` you set yourself. | Issued by operator. |
| `DATA_PROVIDER_API_KEY` | Set on your data-provider. | Not used on your side. |
| Provider keys (`COINGECKO_API_KEY`, `OPENAI_API_KEY`, …) | **On your api + worker.** | **On your api + worker — unchanged.** |
| `SMTP_URL` / `FASTMAIL_API_TOKEN` | On your data-provider. | On operator's data-provider. |
| `S3_*` | On your data-provider. | On operator's data-provider. |
| Pricing / AI / chain calls | Made by your api + worker. | Made by your api + worker — unchanged. |
| Object storage, email, OG metadata, token search | Served by your data-provider. | Served by operator's data-provider. |

## Updated compose file

In `docker-compose.prod.yml`, comment out the `data-provider`
service entirely:

```yaml
# data-provider:
#   image: scani/data-provider:${SCANI_IMAGE_TAG:-latest}
#   ...
```

And remove `data-provider` from the `depends_on` of api and worker:

```yaml
api:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    # data-provider:
    #   condition: service_healthy

worker:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    # data-provider:
    #   condition: service_healthy
```

## Bring it up

```sh
# Step 1 — apply migrations (same as Tier 1)
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate

# Step 2 — bring the long-running services up
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api worker
```

## Confirm the wiring

The api and worker each log a `scaniCloudUrl` field at boot. Grep for
it to confirm they're pointed at the hosted endpoint:

```sh
docker compose -f docker-compose.prod.yml logs api worker \
  | grep -E '"scaniCloudUrl"'
```

Expected (Tier 2):

```
api:    {... "msg":"☁️  Data-provider reachable", "scaniCloudUrl":"https://api.cloud.scani.xyz" ...}
worker: {... "scaniCloudUrl":"https://api.cloud.scani.xyz" ...}
```

If you see `"scaniCloudUrl":"(local fallback)"`, the env vars didn't
take effect — most often because `.env` was edited after `up -d`
without a `down + up -d` to recreate the containers.

## Smoke-test the hosted data-provider

A single tRPC call from your api confirms the bearer is accepted and
the upstream is reachable. The simplest one is a price fetch (no DB
side-effects, no credentials):

```sh
# From a shell on the api host (or `docker compose exec api`):
curl -sX POST "$SCANI_CLOUD_URL/trpc/pricing.fetchCurrentPrice" \
  -H "Authorization: Bearer $SCANI_CLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"json":{"tokenSymbol":"BTC","baseCurrency":"USD"}}'
```

Expected: `{"result":{"data":{"json":{"price":"...","timestamp":"..."}}}}`.

A `401 Unauthorized` means the bearer doesn't match the operator's
`DATA_PROVIDER_API_KEY`. An empty or partial result — a 200 with
nothing useful in it — is what an unconfigured provider key on their
side looks like (`COINGECKO_API_KEY` in this example); nothing in the
response says so, so ask them.

## Rolling back to Tier 1

Same two vars, reverted:

```ini
SCANI_CLOUD_URL=http://data-provider:8082
SCANI_CLOUD_API_KEY=<your local key>
DATA_PROVIDER_API_KEY=<same as above>
```

Uncomment the `data-provider` service block. Recreate everything.

## See also

- [Tier 2 overview](/self-hosting/tier2/overview/)
- [What stays on your side](/self-hosting/tier2/user-creds/)
- [Migrating Tier 1 → Tier 2](/self-hosting/tier2/migration/)
- [Required environment variables](/self-hosting/tier1/required-env/)
