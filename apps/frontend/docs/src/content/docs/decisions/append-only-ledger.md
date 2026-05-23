---
title: Why an append-only ledger
description: The cost basis of every position depends on every economic event that has touched it. An immutable transaction log is the only design that survives corrections without rewriting history.
sidebar:
  order: 1
---

## The decision

`holding_transactions` is **append-only**. Rows are `INSERT`ed and
never `UPDATE`d or `DELETE`d in normal operation. Corrections produce
*new* rows with a different `source`. The current
[holdings.balance](/concepts/holdings/) is a separate, mutable
denormalised cache that the reconciliation flow is allowed to repair.

## The alternative we rejected

A mutable transactions table where re-ingesting an updated payload
overwrites the row in place. Smaller table, simpler ingester code.

## Why we rejected it

**Cost basis is a function of every event.** A buy three years ago,
plus a transfer to self-custody two years ago, plus a sell yesterday
collectively determine the realised PnL of yesterday's close. If the
two-year-old transfer is silently rewritten by a re-ingest (with a
different fee, a corrected counterparty, a fixed timestamp), the
PnL of yesterday's close silently changes too. Tax-relevant numbers
shift under users' feet.

**Re-ingesters cannot be trusted not to drift.** Exchange APIs return
slightly different payloads for the same trade after their normaliser
ships an update. Blockchain RPC re-indexes have different parsed-tx
shapes. CSV exporters re-format columns. The schema has to assume the
inbound stream is noisy.

**Audit trail loss is silent.** Mutating a row destroys the previous
state with no log. By the time a user notices their cost basis
moved, the original is gone.

## How the append-only model survives corrections

A correction is a **new row with a different source**:

- Original Binance row: `source='binance-api'`, `externalId='123'`,
  `quantity='1.0'`.
- Corrected re-import: `source='binance-api-recovered'`,
  `externalId='123'`, `quantity='0.99'` (different fee).

Both stay visible. Readers that want the latest can ORDER BY
`createdAt DESC`. Readers that want the audit trail walk both.

The only ledger row Scani *ever* updates is the synthesised
`opening_balance` row produced by the
[reconciliation flow](/concepts/observations/#opening-balance-reconciliation),
because there is at most one per holding per cycle and updating it
in place is materially simpler than tracking a chain of synthesised
openings. This exception is documented and bounded.

## What this design unlocks

- **Reproducible PnL.** The same query against an old snapshot of the
  ledger produces the same number forever.
- **Forensics.** `rawPayload` carries the original provider response;
  a normaliser bug can be diagnosed and re-parsed without re-fetching.
- **Cross-venue cost basis.** [Transfer linking](/concepts/transfers/)
  works because both legs of a move are preserved as their own rows
  — neither one overwriting the other.
- **The rollup is a cache.** The
  [portfolio-value rollup](/concepts/rollup/) can be dropped and
  rebuilt from `transactions + observations + prices` without losing
  truth. Mutable transactions would make this impossible.
- **The non-negative balance clamp is safe.** [Balance
  reconstruction](/concepts/balance-reconstruction/) can clamp a
  reconstructed past balance at zero (when ledger history is
  incomplete) without rewriting any rows — the *signed* quantities
  remain available for cost-basis math.

## What the design costs

- **Storage.** Some rows are kept indefinitely with `rawPayload`. In
  practice the table is small compared to the prices table; not yet
  a problem.
- **Reader complexity.** Naïve reads must filter to the latest row
  per `(holdingId, source, externalId)` when corrections exist.
  Mitigated by the dedup constraint — most ingesters never produce
  corrections, so most reads are direct.

## What this rules out

- An "edit transaction" feature that lets users mutate a row in
  place. The supported pattern is: hide the wrong row (mark inactive
  or filter), then insert a correcting row.
- An admin "undo" that deletes rows. Use a counter-entry
  (`source='manual-correction'`) instead.

## See also

- [Transactions (the ledger)](/concepts/transactions/)
- [Observations & coverage](/concepts/observations/)
- [Portfolio value rollup](/concepts/rollup/)
- [Balance reconstruction](/concepts/balance-reconstruction/)
