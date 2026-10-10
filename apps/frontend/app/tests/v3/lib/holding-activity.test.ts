import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import en from '../../../src/v3/i18n/locales/en.json';
import { activityKindLabel } from '../../../src/v3/lib/holding-activity';

/**
 * A dividend reads as a dividend, and the tax taken from it as tax withheld
 * (SC-1644), where both used to read "Reward" and "Fee".
 */

const t = i18n.t.bind(i18n);
const kinds = en.v3.holdings.activity.kind;
const DIVIDENDS = new Set(['div-1']);

describe('activityKindLabel (SC-1644)', () => {
  test('income/dividend reads Dividend', () => {
    expect(
      activityKindLabel(t, { kind: 'reward', quantity: '10', kindSubtype: 'dividend' }, DIVIDENDS)
    ).toBe(kinds.dividend);
  });

  test('a reward that is not a dividend still reads Reward', () => {
    expect(
      activityKindLabel(t, { kind: 'reward', quantity: '10', kindSubtype: 'reward' }, DIVIDENDS)
    ).toBe(kinds.reward);
  });

  test('a fee linked to a dividend reads Tax withheld', () => {
    expect(activityKindLabel(t, { kind: 'fee', quantity: '-1.5', feeOf: 'div-1' }, DIVIDENDS)).toBe(
      kinds.taxWithheld
    );
  });

  test('a fee linked elsewhere reads Fee', () => {
    expect(activityKindLabel(t, { kind: 'fee', quantity: '-1', feeOf: 'trade-9' }, DIVIDENDS)).toBe(
      kinds.fee
    );
    expect(activityKindLabel(t, { kind: 'fee', quantity: '-1' }, DIVIDENDS)).toBe(kinds.fee);
  });

  test('an unknown kind falls back to its direction', () => {
    expect(activityKindLabel(t, { kind: 'zz-new', quantity: '-3' }, DIVIDENDS)).toBe(
      kinds.moneyOut
    );
    expect(activityKindLabel(t, { kind: 'zz-new', quantity: '3' }, DIVIDENDS)).toBe(kinds.moneyIn);
  });
});
