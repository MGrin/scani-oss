import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';

const t = i18n.t.bind(i18n);

/**
 * The one place `useHoldingActions` / `useAccountActions` changed what a
 * reader sees, rather than only where the string is stored (SC-320).
 *
 * v2 built both bulk-delete toasts by hand — `${n} holding(s) deleted` plus a
 * `, ${failed} failed` suffix appended when some ids failed server-side. Both
 * halves are English grammar: `(s)` has no analogue in a language that
 * inflects, and a sentence assembled from two independently translated
 * fragments cannot be reordered by a translator. So the parenthesised plural
 * is gone and the suffix is part of the sentence, which means the English
 * moves too — that is the disclosure, and this is the assertion of it.
 *
 * The hooks themselves are react-query mutation callbacks and are exercised
 * through the pages; what is checkable without a render is the sentence each
 * count produces, and it is the sentence that changed.
 */
describe('bulk-delete toasts', () => {
  test.each([
    ['v3.holdings.toast.bulkDeleted', 1, '1 holding deleted'],
    ['v3.holdings.toast.bulkDeleted', 4, '4 holdings deleted'],
    ['v3.entities.account.toast.bulkDeleted', 1, '1 account deleted'],
    ['v3.entities.account.toast.bulkDeleted', 4, '4 accounts deleted'],
  ])('%s at count %d reads %p', (key, count, expected) => {
    expect(t(key, { count })).toBe(expected);
  });

  test.each([
    ['v3.holdings.toast.bulkDeletedWithFailures', 1, 2, '1 holding deleted, 2 failed'],
    ['v3.holdings.toast.bulkDeletedWithFailures', 3, 1, '3 holdings deleted, 1 failed'],
    ['v3.entities.account.toast.bulkDeletedWithFailures', 1, 2, '1 account deleted, 2 failed'],
    ['v3.entities.account.toast.bulkDeletedWithFailures', 3, 1, '3 accounts deleted, 1 failed'],
  ])('%s at %d/%d reads %p', (key, count, failed, expected) => {
    expect(t(key, { count, failed })).toBe(expected);
  });

  // The count and the failure count are two different numbers in one sentence,
  // and i18next only owns the first. A `{{failed}}` that never got a value
  // renders as itself and is the kind of thing English hides.
  test('the failure count is interpolated, not left as its placeholder', () => {
    expect(t('v3.holdings.toast.bulkDeletedWithFailures', { count: 3, failed: 1 })).not.toInclude(
      '{{'
    );
  });
});

/**
 * The remaining toasts move one file without moving one letter. Asserted
 * because a key that does not resolve renders as itself, and a toast reading
 * `v3.entities.account.toast.syncing` is exactly as silent as the mixed-
 * language list this ticket exists to fix.
 */
describe('the toasts whose English is unchanged', () => {
  test.each([
    ['v3.holdings.toast.deleted', 'Holding deleted'],
    ['v3.holdings.toast.deletingContext', 'Deleting holding'],
    ['v3.holdings.toast.bulkDeletingContext', 'Deleting holdings'],
    ['v3.holdings.toast.updated', 'Holding updated'],
    ['v3.holdings.toast.updatingContext', 'Updating holding'],
    ['v3.holdings.refresh.price', 'Refreshing price'],
    ['v3.holdings.refresh.balance', 'Refreshing balance'],
    ['v3.entities.account.toast.deleted', 'Account deleted successfully'],
    ['v3.entities.account.toast.deletingContext', 'Failed to delete account'],
    ['v3.entities.account.toast.bulkDeletingContext', 'Failed to delete accounts'],
    ['v3.entities.account.toast.updated', 'Account updated successfully'],
    ['v3.entities.account.toast.updatingContext', 'Failed to update account'],
    ['v3.entities.account.toast.syncing', 'Syncing account — balances will refresh shortly'],
    ['v3.entities.account.toast.syncingContext', 'Failed to start account sync'],
    ['v3.documents.toast.downloadingContext', 'Downloading file'],
  ])('%s reads %p', (key, expected) => {
    expect(t(key)).toBe(expected);
  });
});
