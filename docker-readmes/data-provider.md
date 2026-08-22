<!-- description: Scani tRPC gateway: object storage, mail, OG, token search. github.com/MGrin/scani-oss -->

# scani/data-provider

The shared-service tRPC gateway for **[Scani](https://github.com/MGrin/scani-oss)** —
the self-hostable, open-source portfolio tracker for crypto and traditional
assets.

[`scani/api`](https://hub.docker.com/r/scani/api) and
[`scani/worker`](https://hub.docker.com/r/scani/worker) call this service over
tRPC for four capabilities — this is the seam between self-hosting tiers: in
Tier 1 it runs on `localhost:8082`, in Tier 2/3 it's a hosted endpoint.

- **Object storage** — presigned upload/download, read/write/copy/delete
- **Mail** — Fastmail JMAP, or any SMTP server
- **Open Graph** — SSRF-hardened metadata fetch for institution logos
- **Token search** — symbol → identity lookup across the pricing providers

It also serves `pricing.*`, `ai.*` and `chains.*` routers (CoinGecko, Finnhub,
DeFiLlama, Yahoo Finance, Etherscan V2, Helius, OpenAI), which a caller may use
directly. The api and worker do **not**: they boot the provider registry in
`direct` mode and reach those upstreams themselves, so their own provider API
keys are required on every tier.

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
cp .env.example .env                              # set provider keys
docker compose -f docker-compose.prod.yml up -d
```

## Environment variables

| Variable | Purpose |
|---|---|
| `DATA_PROVIDER_API_KEY` | Bearer token the api + worker present to reach this service (must match `SCANI_CLOUD_API_KEY` on api/worker) |
| `DATABASE_URL` | Postgres — used for upstream-call audit log + cache |

Provider keys (all optional — each one unlocks a specific integration; calls
return `PRECONDITION_FAILED` at runtime if unset):

- `COINGECKO_API_KEY`, `FINNHUB_API_KEY` — pricing
- `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `DEEPSEEK_API_KEY` — AI
- `ETHERSCAN_API_KEY` — EVM wallet balances (one key covers all EVM chains)
- `HELIUS_API_KEY` — Solana
- `FASTMAIL_API_TOKEN`, or `SMTP_URL` / `SMTP_FROM` — magic-link email delivery

Full annotated list: [`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
