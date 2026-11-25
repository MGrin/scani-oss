---
title: Spending by category
description: Inspect monthly recorded spending by category and native currency.
---

Open **Money → Spending by category**. Choose a month and an account, or keep all
included accounts. Months use UTC, from the first day inclusive to the next
month exclusive. The picker supports January 1900 through the current UTC month.
Future-dated transactions do not count yet.

## Read a total

Each currency has a separate total. Scani does not convert currencies or sum them
together. Tokens with the same symbol show their names and IDs separately.

A parent category includes its direct assignments and its subcategories once.
Uncategorized includes recorded spending without a category. Current category
assignments apply, including later renames or moves.

Select a currency total or category to inspect its transactions. The report shows
50 transactions per page. **Previous** and **Next** replace the page. They do not
combine snapshots from different requests. The report is live; an import,
deletion or category change can alter a later response.

Expand **Exact record** for the signed source amount, UTC timestamp and category
path. **Calculation details** exposes exact totals. Scani calculates totals from
unrounded amounts on the server; displayed currency rounding does not change them.

## Understand the limits

This is gross recorded spending. Refunds and other incoming money are not
subtracted. A missing record does not mean no spending occurred. An unpaired
withdrawal may still be an unmatched transfer. The report does not establish
complete spending or affordability.

Only classified negative fiat withdrawals and standalone bank charges count.
Investment, cryptocurrency and debt accounts are excluded, including their
interest and fees. Linked fees, settlement legs, split transfers, income,
trades and unclassified movements are excluded. Calculation details names the
excluded split and unclassified row counts.

Inactive accounts and holdings retain their recorded history and carry inactive
labels. Owner-hidden accounts and holdings remain excluded. Automatically hidden
holdings retain history. Physically deleted data stays absent. Hiding data can
change past totals; deactivation does not.

The report covers your own accounts only. Household membership does not grant
access to another owner’s spending or category names. It does not add budgets,
rollover, forecasts, currency conversion or exports.
