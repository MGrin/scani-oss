---
title: Pointing api + worker at a hosted endpoint
description: The two env vars that switch the api and worker from a local data-provider to a hosted one.
sidebar:
  order: 2
---

## Two env vars

```ini
SCANI_CLOUD_URL=https://data-provider.your-host.example.com
SCANI_CLOUD_API_KEY=<bearer issued by the operator>
```

`SCANI_CLOUD_URL` replaces the Tier-1 default
`http://data-provider:8082` (the compose-network hostname).
`SCANI_CLOUD_API_KEY` is the bearer the api and worker present in
the `Authorization` header on every tRPC call to the data-provider.

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
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api worker
```

The api logs `tier=tier2 cloudUrl=https://...` on boot when
`SCANI_CLOUD_URL` is not the local sentinel. Use that to confirm
the wiring took effect.

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
