import { describe, expect, it, test } from 'bun:test';
import {
  balanceDecimals,
  isDustQuantity,
  moneyDecimals,
  quantityDecimals,
  roundToDecimals,
  SMALLEST_SHOWN_QUANTITY,
} from '../../src/format/precision';

describe('moneyDecimals', () => {
  it('gives an ordinary amount two decimals', () => {
    expect(moneyDecimals('98.33333333333333333333333333')).toBe(2);
    expect(moneyDecimals('130017.64836043886')).toBe(2);
    expect(moneyDecimals('0.01')).toBe(2);
    expect(moneyDecimals('-1234.5')).toBe(2);
  });

  it('gives zero two decimals rather than reaching for significance it has none of', () => {
    expect(moneyDecimals('0')).toBe(2);
    expect(moneyDecimals('0.000')).toBe(2);
  });

  it('extends only for a figure that would otherwise round to nothing', () => {
    // SC-179: LUNC at €0.0000771. `0.00` beside a quantity of 4,200,000 makes a
    // statement that contradicts its own total.
    expect(moneyDecimals('0.00007714915547392611')).toBe(8);
    expect(moneyDecimals('-0.00007714915547392611')).toBe(8);
    // Rounds to €0.01, which is a real answer — nothing to extend for.
    expect(moneyDecimals('0.009')).toBe(2);
  });

  it('extends no further than the figure has digits to justify', () => {
    // Three, not six: `0.004` says everything `0.004000` would.
    expect(moneyDecimals('0.004')).toBe(3);
    expect(moneyDecimals('0.0000000000000001')).toBe(16);
  });

  it('stops at the smallest unit any token has, so a bad price cannot run away', () => {
    expect(moneyDecimals('0.0000000000000000000000001')).toBe(18);
  });

  it('treats an unparseable figure as ordinary money', () => {
    expect(moneyDecimals('')).toBe(2);
    expect(moneyDecimals('n/a')).toBe(2);
  });
});

describe('quantityDecimals', () => {
  it('shows only the digits the quantity actually carries', () => {
    // SC-177: the realized ledger padded every one of these to 8dp.
    expect(quantityDecimals('500000000.00000000')).toBe(0);
    expect(quantityDecimals('1200.00000000')).toBe(0);
    expect(quantityDecimals('3')).toBe(0);
    expect(quantityDecimals('0.05000000')).toBe(2);
    expect(quantityDecimals('0.8241')).toBe(4);
  });

  it('caps an ordinary fraction where a balance stops meaning anything', () => {
    expect(quantityDecimals('1.123456789123')).toBe(8);
  });

  it('lifts that cap only to keep a dust balance from reading as zero', () => {
    // Capped at 8 this is `0.00000000` — a claim that the position is empty.
    expect(quantityDecimals('0.000000001')).toBe(9);
    expect(quantityDecimals('0.000000000123456789')).toBe(13);
  });

  it('reads a number as readily as a decimal string', () => {
    expect(quantityDecimals(84)).toBe(0);
    expect(quantityDecimals(0.2841)).toBe(4);
  });

  it('has nothing to show for a figure that is not one', () => {
    expect(quantityDecimals(Number.NaN)).toBe(0);
    expect(quantityDecimals(null)).toBe(0);
    expect(quantityDecimals('')).toBe(0);
  });
});

describe('roundToDecimals', () => {
  it('rounds rather than truncates, and never through a float', () => {
    expect(roundToDecimals('98.33333333333333333333333333', 2)).toBe('98.33');
    expect(roundToDecimals('0.867', 2)).toBe('0.87');
    expect(roundToDecimals('35.13513513513512', 2)).toBe('35.14');
    expect(roundToDecimals('-0.005', 2)).toBe('-0.01');
  });

  it('writes the decimals it was asked for, padding a short figure', () => {
    expect(roundToDecimals('12', 2)).toBe('12.00');
    expect(roundToDecimals('4914', 0)).toBe('4914');
  });

  it('never emits an exponent, whatever the magnitude', () => {
    expect(roundToDecimals('0.0000000000000001', 16)).toBe('0.0000000000000001');
    expect(roundToDecimals('1e21', 0)).toBe('1000000000000000000000');
  });

  it('leaves a figure it cannot parse exactly as it found it', () => {
    expect(roundToDecimals('n/a', 2)).toBe('n/a');
  });
});

/**
 * SC-567 — the predicate a SCANNING surface asks before it renders a quantity.
 *
 * `quantityDecimals` above extends past the cap so an INSPECTION surface can
 * show a dust balance exactly. That is right for the peek and for a CSV, and
 * wrong for a list row, where eighteen decimals in the value zone squeeze the
 * identity zone until the account name clips. This says which case you are in.
 *
 * The one answer neither surface may give is `0`, which is not a rounding of a
 * small position but a claim that it is empty.
 */
describe('isDustQuantity', () => {
  test('a real balance under the display cap is dust', () => {
    expect(isDustQuantity('0.0000000004013')).toBe(true);
    expect(isDustQuantity('0.000000000000000001')).toBe(true);
    // Exactly at the boundary of what 8 decimals can show, from below.
    expect(isDustQuantity('0.000000004')).toBe(true);
  });

  test('a balance the cap can show is not dust, including the smallest of them', () => {
    expect(isDustQuantity(SMALLEST_SHOWN_QUANTITY)).toBe(false);
    expect(isDustQuantity('0.00000002')).toBe(false);
    expect(isDustQuantity('143.59019742')).toBe(false);
    expect(isDustQuantity('12500')).toBe(false);
  });

  test('zero is not dust — it is zero, and it may be rendered as zero', () => {
    // The distinction the whole ticket rests on. A position that IS empty is
    // entitled to say so; one that is merely small is not.
    expect(isDustQuantity('0')).toBe(false);
    expect(isDustQuantity(0)).toBe(false);
  });

  test('nothing at all is not dust', () => {
    expect(isDustQuantity(null)).toBe(false);
    expect(isDustQuantity(undefined)).toBe(false);
    expect(isDustQuantity('')).toBe(false);
    expect(isDustQuantity('not a number')).toBe(false);
  });

  test('a negative dust balance is dust', () => {
    // `holdings.balance` is non-negative by schema, but this rule is about
    // magnitude and answering on the sign would be an accident waiting.
    expect(isDustQuantity('-0.0000000004013')).toBe(true);
  });

  test('the threshold is the cap written out, with no exponent', () => {
    // It reaches a spreadsheet cell through the export path, where `1e-8` is
    // text to some readers and a number to none.
    expect(SMALLEST_SHOWN_QUANTITY).toBe('0.00000001');
    expect(SMALLEST_SHOWN_QUANTITY).not.toContain('e');
    expect(isDustQuantity(SMALLEST_SHOWN_QUANTITY)).toBe(false);
  });

  test('the boundary is where the figure ROUNDS to zero, not where it falls below the cap', () => {
    // Non-obvious and worth pinning: `vanishesAt` asks whether
    // `toDecimalPlaces(8)` leaves nothing, and that rounds HALF-UP. So the
    // edge sits at 5e-9, not at the cap itself — `0.000000009` displays as
    // `0.00000001`, which is a true statement about a real balance and needs
    // no threshold. Only a figure that would render as `0` gets one.
    //
    // Written down because the obvious reading of "too small for the column"
    // is `< 1e-8`, and a future simplification to that would start putting
    // `< 0.00000001` over balances the column can show exactly.
    expect(isDustQuantity('0.000000009')).toBe(false);
    expect(isDustQuantity('0.000000005')).toBe(false);
    expect(isDustQuantity('0.0000000049')).toBe(true);
    expect(isDustQuantity('0.000000004')).toBe(true);
  });
});

describe('balanceDecimals', () => {
  test('a fiat balance is money', () => {
    // SC-576. `232.330106461 USD` under a delta of `−10,673.74` is one
    // movement of one balance described at two precisions.
    expect(balanceDecimals('232.330106461', 'fiat')).toBe(2);
    expect(balanceDecimals('10906.066301185', 'fiat')).toBe(2);
  });

  test('a crypto or stock balance is a count', () => {
    // Money-rounding a count is the failure that has no tell: `0.05` is a
    // plausible reading of `0.05421` and the reader cannot know it is short.
    expect(balanceDecimals('0.05421', 'crypto')).toBe(5);
    expect(balanceDecimals('12.5', 'stock')).toBe(1);
  });

  test('an unknown token type falls to the count rule, not the money rule', () => {
    // The default is load-bearing and is the reason the money set is named
    // positively rather than the count set. A type an admin adds to
    // `token_types` tomorrow gets no migration and no thought here, and of the
    // two ways to be wrong about it only the money rule loses digits silently.
    //
    // A future reader will be tempted to invert this — "surely a new type is
    // more likely to behave like the common case" — so the argument, not just
    // the assertion: `fiat` is the ONLY type whose quantity is an amount of
    // money (`lib/manual-balance-edit.ts` makes that case at length), and a
    // set of one is not the common case.
    expect(balanceDecimals('0.05421', 'some-type-invented-later')).toBe(5);
    expect(balanceDecimals('0.05421', null)).toBe(5);
    expect(balanceDecimals('0.05421', undefined)).toBe(5);
  });

  test('NEITHER branch can render a non-zero balance as zero', () => {
    // The SC-567 property, and the reason choosing between the two rules here
    // is safe at all. Both extend past their own precision rather than vanish,
    // so a dust balance survives whichever branch it takes.
    expect(balanceDecimals('0.000000004218', 'fiat')).toBeGreaterThan(2);
    expect(balanceDecimals('0.000000004218', 'crypto')).toBeGreaterThan(8);
  });
});
