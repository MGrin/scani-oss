---
title: Migrating Tier 1 → Tier 2
description: A working migration plan, with a rollback strategy if the hosted data-provider doesn't pan out.
sidebar:
  order: 4
---

The migration is **two env-var changes and a compose-file edit**. No
data migration, no downtime if you do it right.

## Pre-migration checklist

- You have an issued `SCANI_CLOUD_URL` and `SCANI_CLOUD_API_KEY`
  from the data-provider operator.
- You have a recent Postgres backup (this should be true regardless;
  see [Backup & restore](/self-hosting/tier1/backup-restore/)).
- You've noted which provider keys you currently have set
  (`COINGECKO_API_KEY`, `OPENAI_API_KEY`, etc.). **These stay.** They
  are read by your api and worker on every tier, not by the
  data-provider — see
  [You still need your provider API keys](/self-hosting/tier2/overview/#you-still-need-your-provider-api-keys).

## The migration

1. **Edit `.env`:**

   ```diff
   - SCANI_CLOUD_URL=http://data-provider:8082
   - SCANI_CLOUD_API_KEY=dev_data_provider_key_change_me_not_prod_safe
   + SCANI_CLOUD_URL=https://data-provider.your-host.example.com
   + SCANI_CLOUD_API_KEY=<issued key>
   ```

2. **Edit `docker-compose.prod.yml`:** comment out the
   `data-provider` service and remove `data-provider` from the
   `depends_on` of `api` and `worker` (see
   [Pointing api + worker at a hosted endpoint](/self-hosting/tier2/wiring/)).

3. **Recreate api + worker.** The data-provider container stops
   automatically when you `docker compose up -d` against a compose
   file that no longer defines it.

   ```sh
   docker compose -f docker-compose.prod.yml up -d
   ```

4. **Watch the logs:**

   ```sh
   docker compose -f docker-compose.prod.yml logs -f api worker
   ```

   The api and worker each log a `scaniCloudUrl` field on boot —
   there is no `tier` field. Confirm it reads your hosted endpoint
   and not `(local fallback)`:

   ```sh
   docker compose -f docker-compose.prod.yml logs api worker \
     | grep -E '"scaniCloudUrl"'
   ```

   While you are in the logs, check the provider-credentials line too
   (see [Do not remove your provider API
   keys](#do-not-remove-your-provider-api-keys)) — it should read the
   same before and after the migration.

5. **Verify with a synthetic call:**
   - Open the SPA, navigate to the dashboard, check that prices are
     fresh.
   - Trigger a manual sync on one integration.
   - Trigger a screenshot import (if you use it).

## What you didn't have to do

- **No data migration.** All your data is in your Postgres. It
  stays. Sync history, transaction ledger, observations, vaults —
  all intact.
- **No re-authentication for users.** Sessions live in your
  Postgres; the tier change is invisible to users.
- **No re-encryption of integration credentials.** They stay
  encrypted with your `ENCRYPTION_KEY` on your machine.

## Rolling back

If something is wrong with the hosted endpoint and you need to fall
back:

1. Revert the `.env` change:

   ```ini
   SCANI_CLOUD_URL=http://data-provider:8082
   SCANI_CLOUD_API_KEY=<your local key>
   DATA_PROVIDER_API_KEY=<same as above>
   ```

2. Uncomment the `data-provider` service in
   `docker-compose.prod.yml`.

3. `docker compose -f docker-compose.prod.yml up -d`.

Your provider keys never left, so pricing, AI and chain syncs are
unaffected by the round trip in either direction — they were never
routed through the data-provider at all.

Email, OG-metadata fetching and token search fall straight back to
their local implementations as soon as `SCANI_CLOUD_URL` points at
your own container again.

:::caution[Object storage does not roll back]
Uploads made while you were on Tier 2 live in the **operator's**
bucket. Pointing `SCANI_CLOUD_URL` back at your own container points
`StorageFacade` back at your `S3_*` bucket, where those objects are
not. Screenshots and imported statement files from the Tier-2 period
will fail to load until you copy them across. The extracted holdings
and transactions are unaffected — those are rows in your Postgres.
:::

## After the migration settles

Once you're confident in the hosted endpoint:

- Permanently remove the `data-provider` service block from your
  compose file.
- Remove `DATA_PROVIDER_API_KEY` and the `S3_*` block from your
  `.env` — the first was only ever the bearer your own container
  validated, and object storage is now the operator's bucket.

### Do not remove your provider API keys

:::danger
`COINGECKO_API_KEY`, `FINNHUB_API_KEY`, `ETHERSCAN_API_KEY`,
`HELIUS_API_KEY` and `OPENAI_API_KEY` are read by **your api and
worker**, on every tier. Pointing `SCANI_CLOUD_URL` at a hosted
data-provider does not move pricing, AI or chain calls off your
machine — all three backend services boot the provider registry in
`direct` mode and call those upstreams themselves.

Deleting them does not fail at boot. Your stack comes up green and
then quietly serves bad data: Finnhub returns null for every equity
price, CoinGecko drops to the public rate-limited tier, Etherscan
goes out unauthenticated, Helius falls back to the throttled public
Solana RPC, and OpenAI throws on every screenshot parse.

Confirm what your stack actually resolved with
`docker compose -f docker-compose.prod.yml logs api worker | grep 'provider credentials:'` —
[the full check is on the overview page](/self-hosting/tier2/overview/#how-to-check-rather-than-guess).
:::

## What actually moves

Four things, and only four — they are the only adapters
`packages/clients/cloud-client/src/` has:

| Moves to the hosted data-provider | Stays on your api + worker |
|---|---|
| Object storage (screenshots, file imports) | Pricing (CoinGecko, DeFiLlama, Frankfurter, Finnhub) |
| Email transport (Fastmail JMAP / SMTP) | AI inference (OpenAI) |
| Open Graph metadata (institution logos) | Chain calls (Etherscan, Helius, Bitcoin, Tron, TON) |
| Token search (symbol → identity) | Every user-credentialed exchange and brokerage integration |

So `SMTP_URL`, `FASTMAIL_API_TOKEN` and `S3_*` can come out of your
`.env` — magic-link emails go through the operator's transport and
uploads land in their bucket. The provider API keys cannot.

## See also

- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Pointing api + worker at a hosted endpoint](/self-hosting/tier2/wiring/)
- [What stays on your side](/self-hosting/tier2/user-creds/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
