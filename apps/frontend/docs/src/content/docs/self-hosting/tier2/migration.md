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
  (`COINGECKO_API_KEY`, `OPENAI_API_KEY`, etc.) — you'll keep them
  in your `.env` for now, ready to fall back to.

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

   The api logs its tier on boot. Confirm `tier=tier2` and
   `cloudUrl=https://...`.

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

This is why you keep your provider keys (`COINGECKO_API_KEY`,
`OPENAI_API_KEY`, …) in `.env` for the first few weeks of Tier 2 —
rollback is instant if you keep the local fallback warm.

## After the migration settles

Once you're confident in the hosted endpoint:

- Remove the provider keys from your `.env` (they're unused on
  your side in Tier 2; leaving them is harmless but messy).
- Permanently remove the `data-provider` service block from your
  compose file.
- Consider lowering `WORKER_CONCURRENCY` if your sync workload was
  bottlenecked by the local data-provider's rate-limiter (the
  hosted endpoint will have its own limits, often higher).

## Email moves too

If you previously had `SMTP_URL` or `FASTMAIL_API_TOKEN` set
locally, those are now provided by the hosted data-provider. You
can remove them from your `.env`. Magic-link emails will be sent
through the operator's transport.

## See also

- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Pointing api + worker at a hosted endpoint](/self-hosting/tier2/wiring/)
- [What stays on your side](/self-hosting/tier2/user-creds/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
