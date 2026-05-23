---
title: Groups
description: User-defined tags for organising holdings and accounts. Pure UI labels with no financial semantics.
sidebar:
  order: 12
---

## Summary

A **group** is a user-defined tag with a name, hex colour, optional
description, and display order. Groups attach to both
[holdings](/concepts/holdings/) and [accounts](/concepts/accounts/) via
many-to-many junction tables. **They are pure UI labels** — they don't
change calculations, don't have a target, don't have a currency, don't
participate in the [rollup](/concepts/rollup/). Use them for filtering,
categorisation, or any organisation scheme you like ("Crypto",
"Retirement", "Side projects", "Speculative", "Tax2024", …).

## Schema

`groups`:

| Column | Meaning |
|---|---|
| `id` | uuid PK. |
| `userId` | uuid → `users.id`. |
| `name` | Unique per user. |
| `color` | Hex string (`#3b82f6`). |
| `description` | Free text. |
| `displayOrder` | `real`, used for custom UI ordering. |
| `isActive` | |
| `createdAt` / `updatedAt` | |

`holding_groups` (junction): `(holdingId, groupId)` unique.

`account_groups` (junction): `(accountId, groupId)` unique.

## Many-to-many on both sides

One holding can belong to multiple groups; one group contains many
holdings. The same applies to accounts. A single BTC holding can be
tagged simultaneously as **Speculative** and **Tax2024**, for
example.

Account-group attachment and holding-group attachment are independent
— putting an account in a group does *not* automatically put its
holdings in that group. That's intentional: a user might tag the
account itself as "Personal — Kraken" while individually tagging
specific positions inside it as "Speculative".

## Groups vs vaults

A common confusion. The short version:

| Need | Use |
|---|---|
| "How close am I to my $50k goal?" | [Vault](/concepts/vaults/) |
| "Show me only my retirement holdings." | Group |
| "Sum my crypto vs my equities." | Group (filter), then read the [rollup](/concepts/rollup/). |
| "25% of this BTC counts toward my house deposit." | Vault (with percentage split). |

See the [Vaults vs groups table](/concepts/vaults/#vaults-vs-groups)
on the vaults page for the full comparison.

## Lifecycle

- Created via `groups.create`.
- Holdings attach via `groups.attachHolding`; accounts via
  `groups.attachAccount`.
- Deleting a group cascades to junction rows but leaves the
  holdings/accounts intact.

There is no cron for groups; they're entirely synchronous user state.

## See also

- [Holdings](/concepts/holdings/)
- [Accounts & institutions](/concepts/accounts/)
- [Vaults](/concepts/vaults/)
- [Glossary: group](/reference/glossary/#group)
