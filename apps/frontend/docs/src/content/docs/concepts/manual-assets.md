---
title: Manual assets
description: How Scani tracks assets that don't have a provider — home equity, private equity, offline portfolios, IOUs — using the same primitives as connected accounts.
sidebar:
  order: 14
---

## Summary

Not every asset has an API. Home equity, private-company shares, a
friend's IOU, an offline gold position, a property in real estate —
Scani tracks these as **manual holdings** under a synthetic *manual
institution*. They live in the same `accounts` / `holdings` /
`holding_transactions` / `holding_balance_observations` tables as
synced positions; the only differences are
`holdings.source = 'manual'` and a `NULL` `externalId`. Manual
holdings inherit the whole [mental model](/concepts/mental-model/) —
the [ledger](/concepts/transactions/), the
[rollup](/concepts/rollup/), [vaults](/concepts/vaults/),
[groups](/concepts/groups/), and the
[holding-inclusion rule](/decisions/holding-inclusion-rule/).

## How a manual holding is created

Three entry points:

1. **Direct UI entry.** The user picks a [token](/concepts/tokens/),
   an account (or creates a new manual one), and a balance.
2. **Screenshot import.** OpenAI Vision parses a portfolio
   screenshot; the resulting rows land under a manual institution.
3. **CSV / file import.** Bulk-load lots of rows at once.

For each manual holding, the system:

1. Finds or creates a *manual* institution for the user (this is
   per-user — different users get different institution rows for
   their own "Manual" entries, so manual data stays scoped to the
   user even though `institutions` is otherwise shared).
2. Finds or creates an account under that institution, matching by
   source/metadata when the input identifies one.
3. Inserts the [holding](/concepts/holdings/) row with
   `source = 'manual'` and `externalId = NULL`.
4. Optionally appends a `kind='opening_balance'` or `kind='deposit'`
   transaction to seed the ledger at the right starting point.
5. Appends a `source='user-entered'`
   [observation](/concepts/observations/) with the current balance.

## Pricing manual holdings

Manual tokens fall into two buckets:

- **Recognised tokens** — fiat (EUR, USD), known crypto (BTC, ETH),
  public equity (AAPL). These get prices from the configured
  providers via the [price graph](/concepts/pricing/) just like
  synced holdings.
- **Custom tokens** — `private-company` or `other` type tokens that
  no public provider knows about. Prices are entered manually by the
  user. Every edit is logged in `token_price_edit_history`
  (append-only, with `previousPrice`, `newPrice`, `editedByUserId`,
  optional `reason`) so the audit trail survives.

For a Google Sheets-driven workflow, the Google Sheets provider can
read a sheet of `(token, price, currency)` rows on a schedule and
write the prices in — useful for portfolios of dozens of private
positions that update by spreadsheet.

## Updating a manual holding

Manual holdings are **never synced by cron**. They only change when
the user edits them or re-imports. Each user edit appends a
`'manual-correction'` [observation](/concepts/observations/) so the
historical chart picks up the change at the correct timestamp.

If the user changes the holding's balance without adding a
corresponding transaction (e.g. "I just realised this is actually 1.5
BTC, not 1.0"), the
[opening-balance reconciliation](/concepts/observations/#opening-balance-reconciliation)
flow synthesises the implied difference. The user sees this as a
note in the data-quality panel; nothing breaks, and the ledger
stays consistent.

## What you can do with manual holdings

Everything you can do with synced holdings:

- Show up in the dashboard total (subject to the
  [inclusion rule](/decisions/holding-inclusion-rule/)).
- Attach to [vaults](/concepts/vaults/) with percentage splits.
- Tag with [groups](/concepts/groups/).
- Contribute to the [rollup](/concepts/rollup/) and chart.
- Earn yield via an [APY config](/concepts/apy/).
- Be hidden or marked inactive.

## See also

- [Accounts & institutions](/concepts/accounts/)
- [Tokens & market segments](/concepts/tokens/)
- [Observations & coverage](/concepts/observations/)
- [Why manual data is a synthetic institution](/decisions/manual-institution/)
- [Glossary: manual institution](/reference/glossary/#manual-institution)
