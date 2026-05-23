---
title: Why transfer linking runs nightly
description: Inline matching makes ingester order matter and produces half-matches. Nightly matching lets the whole cross-user graph settle before the matcher runs.
sidebar:
  order: 4
---

## The decision

[Transfer linking](/concepts/transfers/) — the process that pairs a
CEX withdrawal to a wallet deposit (and vice versa) by writing a
shared `transferGroupId` — runs **nightly at 03:45 UTC**, after the
hourly ingesters (exchange sync, wallet sync) have had a chance to
write the day's transactions, and before the
[portfolio-value rollup](/concepts/rollup/) at 04:00 UTC depends on
the linked groups.

## The alternative we rejected

**Inline matching.** Every time an ingester wrote a `withdraw` or
`transfer_out` row, the ingester would look for a matching `deposit`
on the user's other accounts within a 30-minute window and link them
on the spot.

## Why we rejected it

**Ingester order would matter.** A user's Binance ingester might run
30 seconds before their Metamask ingester. The Binance withdraw lands
first; inline matching finds no candidate on the Metamask side
because the corresponding deposit hasn't been written yet. The
withdraw is left unlinked. Thirty seconds later the deposit lands,
and *its* inline match finds the unlinked withdraw — but only if the
inline matcher looks both directions. A two-direction matcher then
needs a back-fill pass when the second leg arrives, which is most of
a nightly job already.

**Cross-user ambiguity wouldn't be visible at ingest time.** When
multiple wallets receive deposits of the same token in the same
window, the matcher's job is to *not* confidently link the wrong
pair. That decision is easier with the whole window's data already
written than with rows trickling in one-by-one.

**Inline work makes ingest non-idempotent.** The whole ingester
contract is "produce stable `externalId` per source; re-runs are
no-ops". An inline matcher adds side effects (the `transferGroupId`
gets written, then possibly overwritten by a later candidate) that
break that property.

**Per-ingest cost is unbounded.** A heavy-CEX user with a backfill of
years of withdrawals would trigger per-withdraw matching queries
every time the historical import ran. Nightly matching is one bulk
pass per user per day, regardless of how heavy the day's activity
was.

## What nightly matching looks like

`LinkTransferPairsUseCase.execute({ userId })`:

1. Pull **all** outflows for the user since the configurable
   horizon (`sinceDays`, default ~2 years) in one query.
2. Pull **all** inflows in another query.
3. Match in memory by token, within ±1% quantity drift, within a
   30-minute window. `O(n log n)` per user.
4. Write `transferGroupId` to both rows of each match.
5. Idempotent — rows that already have a `transferGroupId` are
   skipped.

A previous implementation issued one candidates `SELECT` per
outflow. On a backfilled user with thousands of withdraws, the cron
timed out before finishing. Two queries plus in-memory matching is
the design that scales.

## What this design unlocks

- **Ingester contract stays simple.** Ingesters only need to write
  transactions correctly; the matcher is decoupled.
- **Cross-user safety.** The matcher sees the whole window before
  deciding, so genuinely ambiguous pairs stay unlinked (better a
  known gap than a wrong link).
- **Predictable cost.** One bulk pass per user per night.
- **Easy to backfill.** Running the matcher over a wider window
  re-links retroactively.

## What the design costs

- **Up to 24 hours of staleness.** Between an `transfer_out` landing
  and the matcher running, the dashboard shows the legs as
  unlinked. Acceptable for a portfolio tracker; would be
  unacceptable for an exchange.
- **The matcher is its own scheduled job** — see the
  [Job catalogue](/reference/jobs/) (`transfer-linking`).

## What this rules out

- An "instant link" feature triggered on every ingest. If you find
  yourself wanting one, the right move is to expose a manual
  re-link action in the UI that calls the same matcher for one
  user on demand.

## See also

- [Transfers & swaps](/concepts/transfers/)
- [Job catalogue](/reference/jobs/) — `transfer-linking`
- [Why an append-only ledger](/decisions/append-only-ledger/)
