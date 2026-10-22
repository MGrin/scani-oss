---
title: Statements
description: The bank statements imported into an account, the file each came from, and the months no statement covers.
sidebar:
  order: 18
---

## Summary

A **statement** is a bank statement file imported into an account. Scani
keeps the period each statement covers and, when it has one, the stored file
it was read from.

## Where it is shown

- **Account details.** An account with at least one statement has a
  **Statements** section: each statement's period, newest first, and its
  file. A statement whose file was not kept still shows its period, as
  "File not kept".
- **Files.** The filter sheet has an **Account** filter. It lists the
  accounts your files were imported into.

## Months with no statement

Under the section title, Scani names the months no statement covers. It
counts from the month of the account's first statement through the last
complete month. A statement covers every month it touches, even by one day.

For an inactive account, the count stops at the month of its last statement.

## One file, two accounts

A file imported into two accounts is stored once. It appears as a statement
on both accounts, and the Account filter on Files lists both.

## See also

- [Accounts](/concepts/accounts/)
- [Transactions](/concepts/transactions/)
