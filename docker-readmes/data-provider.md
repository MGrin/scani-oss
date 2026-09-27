<!-- description: Scani tRPC gateway: object storage, mail, OG, token search. github.com/MGrin/scani-oss -->

# scani/data-provider

The shared-service tRPC gateway for **[Scani](https://github.com/MGrin/scani-oss)** —
the self-hostable, open-source portfolio tracker for crypto and traditional
assets.

The local Tier 1 stack uses this service for token lookup and metadata. Scani
runs the hosted service for Tier 2: versioned `processing.v1` endpoints provide
AI, pricing and supported public-wallet requests using Scani's provider keys.
Customer API keys also reach token lookup and constrained authentication email.

Tier 2 customers run their UI, API, worker, database, Redis and S3 themselves.
They supply one Scani Cloud key and do not run a local data-provider. Durable
files stay in customer-owned S3; processing inputs travel to Scani Cloud.
`storage.*` and arbitrary `email.send` are restricted to Scani's internal keys.
Personal exchange and broker credentials remain on the customer's instance.

## Tags

- `latest` — highest semver release tag
- `1.2.3` / `1.2` / `1` — semver release tags

## Quick start

Bundled into the reference
[`docker-compose.prod.yml`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.prod.yml)
in the OSS repo:

```bash
git clone https://github.com/MGrin/scani-oss.git
cd scani-oss
./scripts/self-host.sh
```

## Environment variables

| Variable | Purpose |
|---|---|
| `DATA_PROVIDER_API_KEY` | Bearer token the api + worker present to reach this service (must match `SCANI_CLOUD_API_KEY` on api/worker) |
| `DATABASE_URL` | Postgres — used for upstream-call audit log + cache |

Platform keys belong on Tier 1 services or on the Scani-managed cloud service,
not on a Tier 2 customer installation:

- `COINGECKO_API_KEY`, `FINNHUB_API_KEY` — pricing
- `OPENAI_API_KEY` — AI
- `ETHERSCAN_API_KEY` — EVM wallet balances (one key covers all EVM chains)
- `HELIUS_API_KEY` — Solana
- `FASTMAIL_API_TOKEN`, or `SMTP_URL` / `SMTP_FROM` — magic-link email delivery

Full annotated list: [`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
