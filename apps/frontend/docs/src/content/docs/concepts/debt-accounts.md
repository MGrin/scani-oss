---
title: Loans, mortgages and cards
description: How Scani records what you owe — a negative cash balance on a liability account — so net worth subtracts it, and how loan and card terms give a payoff projection.
sidebar:
  order: 16
---

## Summary

A loan, a mortgage or a credit card is an **account whose type has the
`liability` class**. What it owes is an ordinary
[holding](/concepts/holdings/): fiat cash, stored **negative**. Net worth,
its history and every total already sum signed values, so a mortgage of
480,000 lowers net worth by 480,000 with no special case anywhere in the
[rollup](/concepts/rollup/).

You type the amount owed as a positive number. The app stores it negative
and shows it back positive, labelled "Amount owed".

## Account types

Four types carry the `liability` class: **Loan**, **Mortgage**, **Credit
Card** and **Other Liability**. Every other type is an `asset`. The class
lives on `account_types.class`.

## The one place a balance may be negative

Only **fiat on a liability account** may be edited below zero. Everywhere
else, an edit that would leave a holding negative is refused, and an outflow
larger than the balance is refused. On a liability account an outflow — spending on
the card, drawing more of the loan — deepens what is owed instead.

Correcting the amount owed is recorded as a `correction`, not as money moving
in or out.

## What debt is left out of

Debt is not an investment, so any holding on a liability account is left out of
**Returns** (named there as a debt account) and adds no **profit or loss**:
its cost equals its value, so realized and unrealized P&L read zero. It stays
in net worth.

On the home page, all debt — margin debt from a broker and what loans and
cards owe — is one **Debt** line beside the allocation, with loans and cards
broken out beneath it.

## Terms, schedule and payoff

A liability account can carry its terms in `liability_terms`, one row per
account:

- **Loan or mortgage:** annual rate, term in months, start date, original
  principal, and optionally the contracted payment.
- **Credit card:** annual rate, credit limit, minimum payment and annual fee.

From these, Scani computes a fixed-rate amortization schedule, and the
account's page shows the monthly payment and the projected payoff date. They
are **computed on read and never stored**, so changing the terms or the
amount owed moves them at once.

Variable rates and a what-if payoff simulator are not supported.

## See also

- [Accounts & institutions](/concepts/accounts/)
- [Holdings](/concepts/holdings/)
- [Manual assets](/concepts/manual-assets/)
