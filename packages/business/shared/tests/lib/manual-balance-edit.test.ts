import { describe, expect, test } from 'bun:test';
import {
  isManualEditCause,
  MANUAL_EDIT_CAUSES,
  manualEditNeedsCause,
} from '../../src/lib/manual-balance-edit';

describe('manualEditNeedsCause', () => {
  test('a holding whose price we fetch answers for itself', () => {
    expect(manualEditNeedsCause('crypto')).toBe(false);
    expect(manualEditNeedsCause('stock')).toBe(false);
  });

  /**
   * **The test somebody will try to delete, and the reason is right here so
   * they have to argue with it rather than with the assertion.**
   *
   * "Fiat is priced — we fetch an FX rate for every currency in the product,
   * `token_prices` has rows for it, `PricingProviderRouter` routes it to
   * `exchangeRate`. So why is it in the ask bucket with the private-company
   * tokens that have no provider at all?"
   *
   * Because the question is not whether a price exists. It is whether
   * performance can reach the holding through a channel OTHER than the number
   * being edited. For 15 AAPL shares it can: the price moves and the share
   * count does not, so a share count going to 20 is a purchase. For £5,000 of
   * cash the quantity IS the money — FX moves its value in base currency, but
   * the interest that account pays arrives as a quantity change that looks
   * exactly like a deposit, and there is no other signal anywhere.
   *
   * Move fiat to the automatic side and every hand-tracked savings account in
   * the product returns exactly 0% forever, because each month's interest is
   * booked as money the owner paid in. That number is flat and plausible, so
   * nobody reports it.
   */
  test('fiat asks, even though we fetch a price for it', () => {
    expect(manualEditNeedsCause('fiat')).toBe(true);
  });

  test('a token whose price only a human ever typed asks', () => {
    expect(manualEditNeedsCause('private-company')).toBe(true);
    expect(manualEditNeedsCause('other')).toBe(true);
  });

  /**
   * Token types are rows in `token_types`, which is admin-extensible without
   * a migration — so an unseen code is a real state, not a hypothetical. It
   * must land on the side that ASKS: guessing wrong there is a wrong number
   * that renders as a plausible one, and guessing wrong the other way is a
   * question the user finds obvious.
   */
  test('a token type nobody has seen yet asks rather than guesses', () => {
    expect(manualEditNeedsCause('commodity')).toBe(true);
    expect(manualEditNeedsCause('')).toBe(true);
  });
});

describe('isManualEditCause', () => {
  test('accepts exactly the three causes', () => {
    for (const cause of MANUAL_EDIT_CAUSES) expect(isManualEditCause(cause)).toBe(true);
  });

  test('rejects anything else, including null from a never-answered holding', () => {
    expect(isManualEditCause(null)).toBe(false);
    expect(isManualEditCause(undefined)).toBe(false);
    expect(isManualEditCause('')).toBe(false);
    expect(isManualEditCause('deposit')).toBe(false);
  });
});
