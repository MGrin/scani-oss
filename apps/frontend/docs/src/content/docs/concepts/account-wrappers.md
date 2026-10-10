---
title: Account wrappers
description: An optional label on an investment or crypto account (ISA, SIPP, Roth IRA and so on) that groups its gains into one of four buckets.
sidebar:
  order: 17
---

## Summary

An account can carry a **wrapper**: the kind of account it is held in, such
as an ISA, a SIPP, a Roth IRA or a TFSA. The wrapper is optional. An account
with none is an ordinary account.

A wrapper is a label and a grouping. **No tax is computed.** It does not
change which gains exist, their cost basis, or any total.

## Where it is set

- **Creating an account.** The account step of manual entry has an
  "Account wrapper" picker. The wrappers for the region of your base
  currency come first, then the ones valid anywhere, then the other regions.
- **Editing an account.** "Edit account" on an account's details sets its
  name, type and wrapper.

Only asset accounts take a wrapper, crypto accounts included. A loan,
mortgage or card refuses one, and an account cannot change type between an
asset type and a [liability type](/concepts/debt-accounts/).

## The four buckets

Each wrapper belongs to one bucket:

| Bucket | For example |
|---|---|
| General | Brokerage, an ordinary account, no wrapper at all |
| Deferred (pensions) | SIPP, 401(k), RRSP, workplace pension |
| Sheltered (ISA, Roth, TFSA) | ISA, Roth IRA, TFSA |
| Other advantaged | HSA, 529 plan, RESP |

The list holds 46 wrappers across the US, UK, Canada, Australia, the EU and
codes valid anywhere. The table `account_wrappers` holds them, and
`accounts.wrapper` refers to one.

## Gains by account wrapper

Home shows a tile with the gain inside wrapped accounts. Its detail lists
each bucket with an account in it, realized and unrealized, over the same
window as the returns card.

- **Realized** is each holding's cumulative realized gain at the end of the
  window, minus the same figure the day before the window starts. A holding
  opened inside the window starts from zero.
- **Unrealized** is at the end of the window.
- Both are read from the per-holding rows of the
  [rollup](/concepts/rollup/). A holding with no price on a day is skipped
  on that day, so each side uses the holding's last priced day. The detail
  says how many holdings this affects.
- An account is grouped by its wrapper **today**, for the whole window.
- While the history is being rebuilt after an edit, the figures are
  withheld rather than mixed from the old and new history.
- The tile does not appear when no account has a wrapper.

MCP clients read the same figures as `gains_by_treatment` on `get_returns`,
and `get_allocation` splits value by bucket with the `treatment` dimension.

## See also

- [Accounts](/concepts/accounts/)
- [Loans, mortgages and cards](/concepts/debt-accounts/)
- [Rollup](/concepts/rollup/)
