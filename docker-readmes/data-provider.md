<!-- description: Scani 3rd-party tRPC gateway: pricing, AI, on-chain, mail. github.com/MGrin/scani-oss -->

# scani/data-provider

Centralized outbound-call tRPC service for **[Scani](https://github.com/MGrin/scani-oss)** —
the self-hostable, open-source portfolio tracker for crypto and traditional
assets.

All credentialed 3rd-party calls fan out from here:

- **Pricing** — CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Yahoo Finance, Google Sheets
- **On-chain** — Etherscan V2 (Ethereum + every EVM chain it supports), Helius (Solana)
- **AI** — OpenAI (screenshot parsing), Perplexity, DeepSeek
- **Mail** — Fastmail JMAP, or any SMTP server

[`scani/api`](https://hub.docker.com/r/scani/api) and
[`scani/worker`](https://hub.docker.com/r/scani/worker) call this service over
tRPC rather than hitting upstream APIs directly — this is the seam between
self-hosting tiers: in Tier 1 it runs on `localhost:8082`, in Tier 2/3 it's a
hosted endpoint.

## Tags

- `latest` — head of `main`
- `sha-<short>` — every push to `main`
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
