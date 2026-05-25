<!-- description: Scani BullMQ consumer. Runs all scheduled + user-initiated async jobs. github.com/MGrin/scani-oss -->

# scani/worker

BullMQ consumer for **[Scani](https://github.com/MGrin/scani-oss)** — the
self-hostable, open-source portfolio tracker for crypto and traditional assets.

Runs every scheduled job (pricing refresh, balance syncs, historical backfills,
transfer linking, APY payouts, …) and every user-initiated job (screenshot
parse, file/wallet/exchange import, user delete) in one binary. Consumes the
`scani-jobs` queue enqueued by [`scani/api`](https://hub.docker.com/r/scani/api);
outbound 3rd-party calls fan out through
[`scani/data-provider`](https://hub.docker.com/r/scani/data-provider).

Repeatable schedules are registered with BullMQ at boot via Postgres advisory
locks, so two overlapping fires of the same job silently no-op rather than
racing — safe to run multiple worker replicas.

## Tags

- `latest` — highest semver release tag
- `1.2.3` / `1.2` / `1` — semver release tags

## Quick start

Use the reference
[`docker-compose.prod.yml`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.prod.yml)
from the OSS repo — it wires the worker up with everything it needs:

```bash
git clone https://github.com/MGrin/scani-oss.git
cd scani-oss
cp .env.example .env                              # set real values
docker compose -f docker-compose.prod.yml up -d
```

## Required environment variables

Same as [`scani/api`](https://hub.docker.com/r/scani/api). The critical ones to
keep in sync between the two:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Must point at the **same** Postgres as the api |
| `REDIS_URL` | Must point at the **same** Redis as the api |
| `ENCRYPTION_KEY` | 32 hex chars; **must match** `scani/api` exactly — credentials encrypted by the api are decrypted here |
| `S3_*` | Same S3-compatible bucket the api uses |
| `SCANI_CLOUD_URL` / `SCANI_CLOUD_API_KEY` | Where `scani/data-provider` lives + bearer to reach it |

Provider keys (CoinGecko, OpenAI, Etherscan, Helius, …) belong on
`scani/data-provider`, not here — the worker calls upstream services through
the data-provider over tRPC.

Full annotated list: [`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
