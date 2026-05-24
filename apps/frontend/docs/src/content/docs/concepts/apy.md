---
title: APY & yield
description: How Scani tracks yield-bearing holdings — staking, lending, savings — and accrues interest as ledger entries.
sidebar:
  order: 13
---

## Summary

Some [holdings](/concepts/holdings/) earn yield: a staked SOL
position, a lending USDC balance, a savings-account EUR balance. Scani
models yield as a **per-holding APY configuration** plus a nightly
`apy-payouts` job that synthesises `kind='interest'`
[transactions](/concepts/transactions/) on schedule. Yield is attached
to the *holding*, not the *token*, because the same stablecoin earns
different rates on different platforms — Compound vs Aave vs a bank
savings account.

## Schema

`holding_apy_configs`:

| Column | Meaning |
|---|---|
| `id` | uuid PK. |
| `holdingId` | uuid → `holdings.id`. **Unique** — at most one APY config per holding. |
| `annualRatePct` | Decimal string. `"4.5"` means 4.5% APY. |
| `payoutFrequency` | `'daily'` \| `'weekdays'` \| `'weekly'` \| `'monthly'` \| `'yearly'`. |
| `payoutDayOfWeek` | 0 (Sun) – 6 (Sat). Used when `frequency = 'weekly'`. |
| `payoutDayOfMonth` | 1–31. Used for `'monthly'` and `'yearly'`. |
| `payoutMonth` | 1–12. Used for `'yearly'`. |
| `lastPayoutAt` | Last time the cron applied a payout for this holding. |
| `isActive` | When false, no payouts are applied. |
| `createdAt` / `updatedAt` | |

## The payout cron

The `apy-payouts` scheduled job runs **daily at midnight UTC**. For
each active APY config:

1. Decide whether today is a payout day per the config's frequency
   and day fields.
2. If yes, compute the accrued interest since `lastPayoutAt`:
   ```
   payout = balance × (annualRatePct / 100) × (daysSinceLastPayout / 365)
   ```
3. Insert a `kind='interest'` transaction with the computed quantity,
   `source = 'apy-cron'`, and `occurredAt = now`.
4. Bump `holdings.balance` accordingly (the holdings row is the
   canonical denormalised cache).
5. Update `lastPayoutAt`.

The synthesised `kind='interest'` row uses the holding's token as
both the holding token and the payout token — APY payouts are paid
in the same asset that earned them (a USDC lending position pays
USDC).

## Why yield is per-holding, not per-token

A user might hold USDC across three venues:

- Coinbase savings (4.5% APY).
- Aave lending (variable, modelled as fixed for simplicity).
- A wallet (0% — sits in self-custody).

Modelling APY on the token would force all three to share a rate.
Modelling it on the holding lets each position have its own rate or
none at all, which matches reality.

## What Scani does *not* model

- **Variable rates that change daily.** The config is one fixed rate.
  Users with truly variable yield should either approximate with a
  fixed rate and edit periodically, or skip the config and let the
  exchange/protocol's actual interest deposits flow in via the
  normal sync (which appears as `kind='reward'` or `kind='interest'`
  from the source).
- **Compounding within a payout period.** The rate is simple-interest
  scaled by `daysSinceLastPayout / 365`. Daily-payout configs
  approximate continuous compounding closely enough for portfolio
  tracking; longer payout frequencies will undercount compounded yield
  slightly.
- **Tax withholding.** Payouts are recorded gross. Jurisdiction-specific
  tax handling is out of scope.

## Lifecycle

- Created via the `holdings.apyConfig.set` mutation.
- Deactivated (rather than deleted) when a user pauses yield
  tracking — preserves the historical `lastPayoutAt` in case they
  re-enable later.
- Deleting the holding cascades to the config.

## See also

- [Holdings](/concepts/holdings/)
- [Transactions (the ledger)](/concepts/transactions/) — the
  `kind='interest'` kind.
- [Job catalogue](/reference/jobs/) — `apy-payouts`.
- [Glossary: APY](/reference/glossary/#apy),
  [APR](/reference/glossary/#apr), [staking](/reference/glossary/#staking).
