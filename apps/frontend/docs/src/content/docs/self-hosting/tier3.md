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
  rate-limit / shut down. Deleting an account clears its id from that
  account's rows (`subject` and `tenant_id`) and keeps the rows, so
  totals hold but a deleted account's usage can no longer be billed to
  it by id.

If you're considering **running** a Tier-3 deployment for others
(rather than using one), the operator-side documentation isn't part
of this OSS docs site yet — the open-source code supports it, but
the operational runbook is a separate effort. Open an issue if
you'd like to see it.

## Switching tiers from a Tier-3 instance

**A backup moves the account.** On the Tier-3 instance, Settings →
Backup writes a copy of it: every record, the balance readings and
decisions its figures come from, your settings and rules, and uploaded
documents with their files. On the new instance, sign up, then choose
Settings → Backup → Restore from a backup. Only an empty account can
take one, and a restore refuses a backup made by a newer Scani than the
one it runs on, so upgrade the new instance first.

What a backup does not carry:

1. **Connections.** Exchange and bank credentials are never in a
   backup. Re-add them on the new instance; connected accounts backfill
   from the source on first sync (`exchange-import`).
2. **Sign-in.** Passkeys, two-factor, agent keys and calendar feed
   links stay behind. Set them up again.
3. **Household sharing and push notifications.** Invite members and
   turn notifications on again.
4. **Documents over the limit.** When the files together would take a
   backup past the 64 MB a restore accepts, it is built without them,
   and the Backup card says how many were left out. Re-upload those
   through the ordinary file-import flow (`file-import`).

Tokens the new instance does not know are listed under Data quality
after the restore. The `user-data-delete` job deletes and does nothing
else: its payload is `{ userId, requestId }` with no flag anywhere in
it, and `DeleteAllUserDataUseCase` only issues deletes. So delete the
Tier-3 account only once the restore has finished.

## See also

- [Tier model](/self-hosting/tier-model/)
- [Tier 2 overview](/self-hosting/tier2/overview/)
- [Why the three-tier deployment model](/decisions/three-tier-model/)
