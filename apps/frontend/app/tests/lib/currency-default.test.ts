import { describe, expect, test } from 'bun:test';
import { baseCurrencyDefaultAction } from '../../src/lib/currency-default';

/**
 * The decision both payment forms run in an effect that depends on `currency`.
 * The bug V3-50 reports — "I cannot change the currency, clicking on change
 * does nothing" — was entirely here: the guard was `currency === null`, so the
 * clear the Change button performs re-entered this decision and refilled the
 * field in the same tick.
 */

const USD = { id: 'token-usd', label: 'USD — US Dollar' };
const EUR = { id: 'token-eur', label: 'EUR — Euro' };

const state = (over: Partial<Parameters<typeof baseCurrencyDefaultAction>[0]> = {}) => ({
  isEdit: false,
  alreadySpent: false,
  baseCurrencyResolved: true,
  currency: null,
  ...over,
});

describe('the base-currency default', () => {
  test('fills an empty create form once the base currency resolves', () => {
    expect(baseCurrencyDefaultAction(state())).toBe('fill');
  });

  test('holds while the base currency is still loading', () => {
    expect(baseCurrencyDefaultAction(state({ baseCurrencyResolved: false }))).toBe('wait');
  });

  test('never touches an edit form, which carries the saved payment currency', () => {
    expect(baseCurrencyDefaultAction(state({ isEdit: true }))).toBe('wait');
  });

  test('clearing the field does not get the base currency back', () => {
    // The regression. Spend it as the create form does on mount, then replay
    // the effect exactly as pressing Change does: currency back to null.
    expect(baseCurrencyDefaultAction(state())).toBe('fill');
    expect(baseCurrencyDefaultAction(state({ alreadySpent: true, currency: null }))).toBe('wait');
  });

  test('a currency chosen before the base one resolves spends the default anyway', () => {
    // The invoice-prefill route: nothing to write, but leaving the default
    // unspent would hand EUR back as USD the moment the user cleared it.
    expect(baseCurrencyDefaultAction(state({ currency: EUR }))).toBe('spend');
    expect(baseCurrencyDefaultAction(state({ alreadySpent: true, currency: null }))).toBe('wait');
  });

  test('a user choice is not overwritten by a later re-run', () => {
    expect(baseCurrencyDefaultAction(state({ alreadySpent: true, currency: USD }))).toBe('wait');
  });
});
