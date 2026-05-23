---
title: Why manual data is a synthetic institution
description: A separate manual-holdings table would have meant two read paths, two write paths, two reconciliation flows. The synthetic-institution pattern means manual holdings inherit every primitive for free.
sidebar:
  order: 3
---

## The decision

Manual holdings — typed in directly, imported from screenshots, or
loaded from CSV — live under a synthetic per-user **"manual"
institution** in the same `institutions` / `accounts` / `holdings` /
`holding_transactions` tables as everything else. The only difference
is `holdings.source = 'manual'` and `externalId = NULL`.

## The alternative we rejected

A separate `manual_holdings` table with its own ledger, its own
observations, its own reconciliation. Sometimes proposed as the
"clean" separation between connected and manual data.

## Why we rejected it

**Two of everything.** A separate `manual_holdings` table would have
implied two read paths (dashboard reads from both, joins separately),
two write paths (every UI mutation duplicated), two reconciliation
flows (the [opening-balance reconciliation](/concepts/observations/)
applies the same logic to both), and two places to enforce the
[holding-inclusion rule](/decisions/holding-inclusion-rule/) (which
already lives twice deliberately — see that decision — and adding a
third copy compounds the maintenance cost).

**Manual data ages.** A holding starts as a manual entry, then the
user connects the corresponding exchange, then the holding becomes
synced. With a separate table, that promotion is a migration: copy
the row across, rewrite every foreign key. With one shared table,
it's a single `UPDATE holdings SET source='binance-api', externalId='BTC'`.

**The economic primitives are identical.** A manual EUR holding has
a balance, can earn yield, can be transferred, has a price, belongs
to a vault, gets tagged with a group. None of those behaviours
differ from a synced position. Forking the schema to reflect a
provenance distinction that doesn't change any downstream behaviour
is duplication for its own sake.

## How the pattern works

Each user gets at most one synthetic *manual* institution row. The
row's `institutionType.code = 'other'` (or a future dedicated
`'manual'` type). When the user creates a manual holding:

1. `INSERT INTO institutions (...)` if the user's manual institution
   doesn't exist yet.
2. `INSERT INTO accounts (...)` under that institution if the
   target account doesn't exist yet (reusing a previously-created
   manual account when source/metadata match).
3. `INSERT INTO holdings (..., source='manual', external_id=NULL)`.

Every subsequent operation on that holding (attach to vault, tag with
group, edit balance, add APY config, hide it, mark inactive) goes
through the same code paths as a synced holding.

## What this design unlocks

- **One inclusion rule, one rollup, one chart.** Manual holdings
  participate in totals without any special-case code.
- **Vaults and groups work across both.** A vault can pull from a
  Kraken USDC position *and* a manual EUR savings account in the
  same allocation — no joins across tables, no UNION queries.
- **The data-quality panel is uniform.** Coverage applies to both;
  reconciliation applies to both.
- **Promotion path is trivial.** Manual → synced is an `UPDATE` of
  two columns.

## What the design costs

- **A user's institution list contains "(Manual)"** alongside Kraken,
  Coinbase, etc. — a minor UI quirk that's well worth the schema
  simplicity.
- **The institution catalogue is no longer purely shared.** Most
  rows are global (everyone's Kraken is the same), but the manual
  institution is per-user. The application enforces this; no schema
  constraint blocks a misuse.

## What this rules out

- A separate `manual_*` table family. If you find yourself wanting
  one, the right move is to add a column or a flag to the existing
  tables.
- A "manual" boolean on `holdings`. The `source` column already
  carries the signal; a redundant flag would drift.

## See also

- [Manual assets](/concepts/manual-assets/)
- [Accounts & institutions](/concepts/accounts/)
- [Why the holding-inclusion rule lives twice](/decisions/holding-inclusion-rule/)
