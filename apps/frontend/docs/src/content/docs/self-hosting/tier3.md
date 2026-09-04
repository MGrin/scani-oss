---
title: Tier 3 — fully managed
description: Someone else runs the whole Scani stack for you.
sidebar:
  order: 100
---

## Summary

**Tier 3** is "someone else runs everything". You sign in to a
hosted Scani instance; the operator runs the api, worker,
data-provider, Postgres, Redis, S3, and the SPA on their hardware.

From your perspective:

- You have a username + password (or magic-link / OTP).
- You connect integrations the normal way.
- Your data lives in the operator's Postgres.
- Your encrypted integration credentials live in the operator's
  Postgres, encrypted with their `ENCRYPTION_KEY`.

## What this gets you

- Zero operational burden.
- The operator handles upgrades, backups, monitoring, scaling.
- All you do is use the app.

## What this costs

- You trust the operator with your portfolio data.
- You trust the operator's `ENCRYPTION_KEY` is well-managed.
- You can leave at any time (the operator can provide an export of
  your data), but it's a "fork your data" move, not a config flip.

## How it's actually built

Tier 3 is just Tier 2 where the *operator* is also you. The same
codebase, the same binaries, the same data-provider, the same SPA.
The cloud-management surface
(`CLOUD_MANAGEMENT_ENABLED=true` on the data-provider) provides:

- DB-backed cloud API keys (so the operator can mint per-user keys
  rather than sharing one).
- A Better-Auth cookie session for the management console.
- Postgres-backed per-request metering
  (`cloud_usage_events` table) so the operator knows what to bill /
  rate-limit / shut down.

If you're considering **running** a Tier-3 deployment for others
(rather than using one), the operator-side documentation isn't part
of this OSS docs site yet — the open-source code supports it, but
the operational runbook is a separate effort. Open an issue if
you'd like to see it.

## Switching tiers from a Tier-3 instance

**Scani ships no data-export feature today**, so there is no
supported way to pull your existing data out of a Tier-3 instance.
The `user-data-delete` job deletes and does nothing else: its payload
is `{ userId, requestId }` with no flag anywhere in it, and
`DeleteAllUserDataUseCase` only issues deletes.

What does work is rebuilding on Tier 2 rather than transferring:

1. Spin up a self-hosted Tier-2 stack
   ([Tier 2 overview](/self-hosting/tier2/overview/)).
2. Re-add your exchange and wallet connections there. Connected
   accounts backfill from the source on first sync
   (`exchange-import`, `wallet-import`), so that history comes back
   without needing anything from the Tier-3 instance.
3. Re-upload any statements or CSVs through the ordinary file-import
   flow (`file-import`). Manual holdings and manually edited prices
   are the part with no source to re-read, and have to be re-entered.

Both a data export and a migration tool that automates this are on
the wishlist.

## See also

- [Tier model](/self-hosting/tier-model/)
- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Why the three-tier deployment model](/decisions/three-tier-model/)
