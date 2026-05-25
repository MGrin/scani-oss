---
title: Pointing api + worker at a hosted endpoint
description: The two env vars that switch the api and worker from a local data-provider to a hosted one.
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

## Working `.env` snippet

A minimal Tier 2 `.env` adds these vars and removes everything that
belonged to the local data-provider (provider keys, SMTP creds, the
Fastmail token, `DATA_PROVIDER_API_KEY`):

```ini
NODE_ENV=production
SCANI_CLOUD_URL=https://api.cloud.scani.xyz
SCANI_CLOUD_API_KEY=sk_live_…   # from cloud.scani.xyz

# Plus everything Tier 1 already required: DATABASE_URL, REDIS_URL,
# FRONTEND_URL, BACKEND_URL, ENCRYPTION_KEY, BETTER_AUTH_SECRET,
# JOBS_HMAC_SECRET, S3_*. See /self-hosting/tier1/required-env/.
```

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
| Provider keys (`COINGECKO_API_KEY`, `OPENAI_API_KEY`, …) | On your data-provider. | On operator's data-provider. |
| `SMTP_URL` / `FASTMAIL_API_TOKEN` | On your data-provider. | On operator's data-provider. |

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
`DATA_PROVIDER_API_KEY`. A `403 Forbidden` or `PRECONDITION_FAILED`
means the operator hasn't configured the relevant provider key on
their side (`COINGECKO_API_KEY` in this example); ask them.

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
