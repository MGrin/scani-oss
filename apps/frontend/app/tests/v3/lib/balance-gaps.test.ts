import { describe, expect, test } from 'bun:test';
import { balanceGapOccurredAt } from '@/v3/lib/balance-gaps';

/**
 * Which answers carry a date, and which must not (SC-501).
 *
 * These exist because the surface shipped with the opposite behaviour and
 * nothing red caught it: the component held a date in state whether or not the
 * field was on screen, sent the untouched default, and the server's clamp kept
 * the resulting row inside the interval — so the row was valid, every test
 * stayed green, and the transaction was stamped at the interval's START
 * instead of at the observation that measured the change. It was found by
 * answering one prompt in a browser and reading the row back.
 */

const wide = { datePrompted: true };
const short = { datePrompted: false };

describe('balanceGapOccurredAt', () => {
  test('a wide interval sends the date the reader picked', () => {
    const at = balanceGapOccurredAt('flow', wide, '2026-07-28');
    expect(at).not.toBeNull();
    // Local midnight, not UTC midnight — the second renders as the 27th
    // everywhere west of Greenwich.
    expect(at?.getFullYear()).toBe(2026);
    expect(at?.getMonth()).toBe(6);
    expect(at?.getDate()).toBe(28);
    expect(at?.getHours()).toBe(0);
  });

  test('a SHORT interval sends no date, even though one is in state', () => {
    // The whole defect, in one assertion. The string below is a perfectly
    // valid date and the component really does hold it; the point is that it
    // was never asked for, so it is not the reader's claim and must not be
    // sent. The server then uses the closing observation, which on an
    // hour-wide interval is more precise than any day could be.
    expect(balanceGapOccurredAt('flow', short, '2026-08-10')).toBeNull();
  });

  test('no other answer carries a date, on either width', () => {
    // `correction` is dated by the server at the moment the superseded figure
    // entered the record — asking would invite "today", which is when it was
    // noticed rather than when it happened. `growth` and `unknown` write no
    // dated row at all.
    for (const gap of [wide, short]) {
      expect(balanceGapOccurredAt('correction', gap, '2026-07-28')).toBeNull();
      expect(balanceGapOccurredAt('growth', gap, '2026-07-28')).toBeNull();
      expect(balanceGapOccurredAt('unknown', gap, '2026-07-28')).toBeNull();
    }
  });

  test('an unparseable date is null rather than an Invalid Date', () => {
    // The field can hold this mid-edit. Returning a Date whose time is NaN
    // would serialise to null over the wire and be indistinguishable from
    // "no date was asked for", which is a different claim.
    expect(balanceGapOccurredAt('flow', wide, '2026-07')).toBeNull();
    expect(balanceGapOccurredAt('flow', wide, '')).toBeNull();
  });
});
