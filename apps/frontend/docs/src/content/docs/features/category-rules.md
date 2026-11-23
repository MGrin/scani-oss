---
title: Saved category rules
description: Review, apply and undo exact-payee category rules for one account.
---

Choose **Categories → Add rule**. Select your own account, a payee and a category.
The saved row shows the normalized payee key before you apply it.
Matching ignores case, punctuation and legal suffixes. If a transaction has no
counterparty, its description supplies the key with digit runs removed.

## Preview and apply

Choose an account and UTC month under **Apply saved rules**, then select
**Preview**. Review every changed transaction, its native amount and its category.
Scani shows protected choices and transactions that already match separately.
It does not total different currencies.

Only reviewed transactions change. New transactions require another preview.
Rules do not run automatically during imports or in the background.
Scani protects personal choices, explicit clears and imported categories.
Rules apply only to eligible negative fiat outflows and fees. Income, trades,
linked transfers and settlement fees stay outside this feature. Categorizing an
unresolved outflow does not decide whether it was spending or a transfer.

A preview supports at most 500 matching transactions and expires after 15 minutes.
You can retain three active previews across all your accounts. Apply an existing
preview or wait for its expiry to free a slot. If reviewed data changes, refresh
the preview before applying. Scani refuses the whole application rather than
applying part of it. The API accepts a finite UTC date interval; the page
currently previews one month.

## Undo and deletion

**Recent applications → Undo** restores category assignments and their previous
source. It does not restore financial amounts, transfer decisions or later edits.
If any changed transaction has since changed, Scani refuses the whole undo.
Editing protected or unchanged transactions does not block undo.

Undo is available for the last 20 applications, including applications already
undone. A new application beyond that window removes the oldest receipt.
Deleting a rule leaves existing categories unchanged. Retained applications can
still be undone after deleting their rule. A category referenced by any saved
rule, including a disabled rule, cannot be deleted until those rules change.
Deleting an account removes its scoped rules.

Backups use format 3 and include saved rules and custom category provenance.
Older instances must upgrade before reading format 3. The current reader also
accepts formats 1 and 2. Undo history belongs to the source instance and does not
travel with a backup. Erasing account data removes rules and their history.
