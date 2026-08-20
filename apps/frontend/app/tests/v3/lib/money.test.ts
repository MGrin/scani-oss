import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  countByVendorId,
  DEFAULT_MONEY_SEGMENT,
  directionLabel,
  endConsequence,
  filterMergeCandidates,
  formatOverdueBy,
  groupUpcoming,
  INCOME_HORIZON_DAYS,
  isIncome,
  MONEY_SEGMENTS,
  mergeConsequence,
  moneySegmentPath,
  occurrencesEndWouldRemove,
  occurrenceTotals,
  PAYMENTS_HORIZON_DAYS,
  paymentDeleteConsequence,
  paymentDeleteCounts,
  resolveMoneySegment,
  splitByDirection,
  splitByDueness,
  vendorDeleteConsequence,
  withinDays,
} from '../../../src/v3/lib/money';

/**
 * The real `t`, bound to the real `en.json` (SC-201).
 *
 * These assertions were written against English built by template literal.
 * They now assert the SAME English assembled from keys — which makes this file
 * the strongest no-behaviour-change check in the extraction: a wrong key, a
 * missing plural form or a reordered frame all change the string these tests
 * already pin.
 */
const t = i18n.t.bind(i18n);

describe('resolveMoneySegment', () => {
  test('the tab opens on what is due, not on the standing list', () => {
    expect(resolveMoneySegment('/payments')).toBe('upcoming');
    expect(DEFAULT_MONEY_SEGMENT).toBe('upcoming');
  });

  test('each segment is a place a link can point at', () => {
    expect(resolveMoneySegment('/payments/recurring')).toBe('recurring');
    expect(resolveMoneySegment('/vendors')).toBe('vendors');
  });

  /**
   * The one that would have shipped broken: the upcoming feed peeks at
   * `/payments/:occurrenceId`, so without claiming `recurring` first the
   * recurring list's own URL reads as an occurrence id and opens a
   * "not found" sheet over the list it was meant to show.
   */
  test('“recurring” is claimed before the fall-through, not read as an id', () => {
    expect(resolveMoneySegment('/payments/recurring')).toBe('recurring');
    expect(resolveMoneySegment('/payments/recurring/abc-123')).toBe('recurring');
    expect(resolveMoneySegment('/payments/abc-123')).toBe('upcoming');
  });

  test('a peek URL stays on the view it was opened from', () => {
    expect(resolveMoneySegment('/vendors/abc-123')).toBe('vendors');
    expect(resolveMoneySegment('/payments/recurring/abc-123/edit')).toBe('recurring');
  });

  test('a trailing slash is the same URL', () => {
    expect(resolveMoneySegment('/payments/recurring/')).toBe('recurring');
    expect(resolveMoneySegment('/vendors/')).toBe('vendors');
  });

  test('every segment round-trips through its own path', () => {
    for (const entry of MONEY_SEGMENTS) {
      expect(resolveMoneySegment(moneySegmentPath(entry.key))).toBe(entry.key);
    }
  });
});

describe('groupUpcoming', () => {
  const occurrence = (id: string, dueDate: string) => ({ id, dueDate });

  test('everything already late leads, in one group', () => {
    const groups = groupUpcoming(
      t,
      [occurrence('c', '2026-08-20'), occurrence('a', '2026-07-01'), occurrence('b', '2026-08-01')],
      '2026-08-12'
    );

    expect(groups[0]?.key).toBe('overdue');
    expect(groups[0]?.overdue).toBe(true);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  test('there is no overdue group when nothing is overdue', () => {
    const groups = groupUpcoming(t, [occurrence('a', '2026-08-20')], '2026-08-12');
    expect(groups.every((group) => !group.overdue)).toBe(true);
  });

  test('the rest is one group per due date, earliest first', () => {
    const groups = groupUpcoming(
      t,
      [occurrence('c', '2026-08-20'), occurrence('a', '2026-08-14'), occurrence('b', '2026-08-14')],
      '2026-08-12'
    );

    expect(groups.map((group) => group.key)).toEqual(['2026-08-14', '2026-08-20']);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  test('today is upcoming, not overdue', () => {
    const groups = groupUpcoming(t, [occurrence('a', '2026-08-12')], '2026-08-12');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.overdue).toBe(false);
  });

  test('no rows means no groups, never one empty one', () => {
    expect(groupUpcoming(t, [], '2026-08-12')).toEqual([]);
  });
});

describe('formatOverdueBy', () => {
  test('counts whole days, singular at one', () => {
    expect(formatOverdueBy('2026-08-11', '2026-08-12', t)).toBe('1 day overdue');
    expect(formatOverdueBy('2026-08-01', '2026-08-12', t)).toBe('11 days overdue');
  });

  // Both dates are compared in UTC, the same way `payments.upcoming` compares
  // them server-side — a local `Date` would move a midnight bill by a day for
  // anyone east of Greenwich.
  test('a date that is not past is not overdue', () => {
    expect(formatOverdueBy('2026-08-12', '2026-08-12', t)).toBe('Due today');
  });

  test('an unparseable date degrades to a word rather than throwing', () => {
    expect(formatOverdueBy('not-a-date', '2026-08-12', t)).toBe('Overdue');
  });
});

describe('directionLabel', () => {
  test('one noun for the field, on both views', () => {
    expect(directionLabel('inflow', t)).toBe('Income');
    expect(directionLabel('outflow', t)).toBe('Bill');
  });
});

describe('countByVendorId', () => {
  test('counts payments per vendor', () => {
    const counts = countByVendorId([{ vendorId: 'a' }, { vendorId: 'b' }, { vendorId: 'a' }]);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBeUndefined();
  });
});

describe('occurrencesEndWouldRemove', () => {
  // These mirror `PaymentService.end`, which deletes `scheduled` rows due
  // strictly after the end date. The count is what the reader is asked to
  // agree to, so a wrong one here is a wrong promise on screen.

  test('counts only scheduled dates strictly after the end date', () => {
    const occurrences = [
      { status: 'scheduled', dueDate: '2026-09-01' },
      { status: 'scheduled', dueDate: '2026-10-01' },
    ];
    expect(occurrencesEndWouldRemove(occurrences, '2026-08-13')).toBe(2);
  });

  test('a date falling ON the end date is still expected, so it is not removed', () => {
    const occurrences = [{ status: 'scheduled', dueDate: '2026-08-13' }];
    expect(occurrencesEndWouldRemove(occurrences, '2026-08-13')).toBe(0);
  });

  test('settled history is never counted — paid and skipped rows survive', () => {
    const occurrences = [
      { status: 'paid', dueDate: '2026-09-01' },
      { status: 'skipped', dueDate: '2026-10-01' },
      { status: 'scheduled', dueDate: '2026-11-01' },
    ];
    expect(occurrencesEndWouldRemove(occurrences, '2026-08-13')).toBe(1);
  });

  test('overdue scheduled rows before the end date are left standing', () => {
    const occurrences = [{ status: 'scheduled', dueDate: '2026-07-01' }];
    expect(occurrencesEndWouldRemove(occurrences, '2026-08-13')).toBe(0);
  });
});

describe('endConsequence', () => {
  test('names the vendor, the date and the exact number of dates removed', () => {
    const sentence = endConsequence('Hetzner', '2026-08-13', 3, t);
    expect(sentence).toContain('Hetzner');
    expect(sentence).toContain('3 scheduled dates');
    expect(sentence).toContain('cannot be undone');
  });

  test('singular reads as a sentence, not as “1 scheduled dates are”', () => {
    const sentence = endConsequence('Hetzner', '2026-08-13', 1, t);
    expect(sentence).toContain('1 scheduled date after that is removed');
    expect(sentence).not.toContain('dates');
  });

  test('says so plainly when nothing is removed, instead of claiming “0”', () => {
    const sentence = endConsequence('Hetzner', '2026-08-13', 0, t);
    expect(sentence).toContain('no scheduled dates after that');
    // Nothing is destroyed, so the irreversibility warning would be noise.
    expect(sentence).not.toContain('cannot be undone');
  });

  test('admits it does not know yet rather than showing a number it may correct', () => {
    expect(endConsequence('Hetzner', '2026-08-13', null, t)).toContain('Checking how many');
  });

  test('promises the settled history is kept, which is what end actually does', () => {
    expect(endConsequence('Hetzner', '2026-08-13', 2, t)).toContain(
      'paid and skipped history is kept'
    );
  });
});

describe('mergeConsequence', () => {
  test('names which vendor survives and which is deleted, in both directions', () => {
    const sentence = mergeConsequence('Amazon', 'AMZN', { payments: 2, aliases: 1 }, t);
    expect(sentence).toContain('"AMZN" is deleted');
    expect(sentence).toContain('"Amazon" is kept');
  });

  test('states what moves across, so “absorbs” is a count and not a metaphor', () => {
    expect(mergeConsequence('Amazon', 'AMZN', { payments: 2, aliases: 1 }, t)).toContain(
      '2 payments and 1 alias move to "Amazon"'
    );
  });

  test('the verb agrees with the whole subject, not the last noun in it', () => {
    expect(mergeConsequence('Amazon', 'AMZN', { payments: 1, aliases: 0 }, t)).toContain(
      '1 payment moves to'
    );
    expect(mergeConsequence('Amazon', 'AMZN', { payments: 2, aliases: 0 }, t)).toContain(
      '2 payments move to'
    );
    expect(mergeConsequence('Amazon', 'AMZN', { payments: 1, aliases: 1 }, t)).toContain(
      '1 payment and 1 alias move to'
    );
  });

  test('omits a zero rather than printing “0 aliases”', () => {
    const sentence = mergeConsequence('Amazon', 'AMZN', { payments: 3, aliases: 0 }, t);
    expect(sentence).toContain('3 payments move');
    expect(sentence).not.toContain('alias');
  });

  test('says nothing moves when nothing points at the duplicate', () => {
    expect(mergeConsequence('Amazon', 'AMZN', { payments: 0, aliases: 0 }, t)).toContain(
      'Nothing points at "AMZN"'
    );
  });

  test('admits it does not know yet while the counts load', () => {
    expect(mergeConsequence('Amazon', 'AMZN', null, t)).toContain('Checking what moves');
  });
});

/**
 * V3-47. The defect these cover shipped in both UIs and in two places in each:
 * a committed-outflow figure filtered to `outflow` printed above a list that
 * was not, so an income invoice appeared as a bill and was missing from the
 * total the reader would have checked it against.
 */
describe('splitting bills from income', () => {
  const row = (id: string, direction: string, dueDate = '2026-08-20') => ({
    id,
    dueDate,
    expectedAmount: '100',
    actualAmount: null,
    payment: { direction, currencyTokenId: 'token-eur' },
  });

  test('income is money arriving, and nothing else decides that', () => {
    expect(isIncome(row('a', 'inflow'))).toBe(true);
    expect(isIncome(row('b', 'outflow'))).toBe(false);
  });

  test('every occurrence lands in exactly one of the two lists', () => {
    const occurrences = [row('a', 'outflow'), row('b', 'inflow'), row('c', 'outflow')];
    const { bills, income } = splitByDirection(occurrences);

    expect(bills.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(income.map((entry) => entry.id)).toEqual(['b']);
    expect(bills.length + income.length).toBe(occurrences.length);
  });

  test('an unknown direction is a bill, so nothing silently vanishes', () => {
    const { bills, income } = splitByDirection([row('a', '')]);
    expect(bills).toHaveLength(1);
    expect(income).toHaveLength(0);
  });

  test('the two horizons are the two questions, and they are not the same', () => {
    expect(PAYMENTS_HORIZON_DAYS).toBe(30);
    expect(INCOME_HORIZON_DAYS).toBe(90);
    expect(INCOME_HORIZON_DAYS).toBeGreaterThan(PAYMENTS_HORIZON_DAYS);
  });
});

/**
 * SC-77 1. `/payments` read "Bills committed, next 30 days: €5,314.53" over a
 * feed whose own OVERDUE section held €4,169.79 of that — one item 151 days
 * late — leaving €1,144.73 actually due in the window the label named. v2
 * computes the same quantity correctly, so the two UIs disagreed about the
 * user's own month.
 *
 * The arithmetic below is the reported figures, to the cent.
 */
describe('splitting overdue bills from the ones still ahead', () => {
  const row = (id: string, dueDate: string, amount: string) => ({
    id,
    dueDate,
    expectedAmount: amount,
    actualAmount: null,
    payment: { direction: 'outflow', currencyTokenId: 'token-eur' },
  });

  const TODAY = '2026-08-13';
  const reported = [
    row('late-151', '2026-03-15', '4000'),
    row('late-2', '2026-08-11', '169.79'),
    row('due-today', TODAY, '144.73'),
    row('due-soon', '2026-08-29', '1000'),
  ];

  test('every bill lands in exactly one of the two sets', () => {
    const { overdue, ahead } = splitByDueness(reported, TODAY);
    expect(overdue.map((entry) => entry.id)).toEqual(['late-151', 'late-2']);
    expect(ahead.map((entry) => entry.id)).toEqual(['due-today', 'due-soon']);
    expect(overdue.length + ahead.length).toBe(reported.length);
  });

  test('a bill due today is not overdue', () => {
    expect(splitByDueness([row('a', TODAY, '1')], TODAY).overdue).toHaveLength(0);
    expect(splitByDueness([row('a', TODAY, '1')], TODAY).ahead).toHaveLength(1);
  });

  test('the 30-day figure stops containing the money the overdue section holds', () => {
    const { overdue, ahead } = splitByDueness(reported, TODAY);
    const sum = (rows: typeof reported) =>
      Array.from(occurrenceTotals(rows).values())
        .map((total) => total.toString())
        .join('+');

    expect(sum(ahead)).toBe('1144.73');
    expect(sum(overdue)).toBe('4169.79');
    // And the number that used to be printed under the forward label.
    expect(sum(reported)).toBe('5314.52');
  });
});

describe('withinDays', () => {
  const row = (id: string, dueDate: string) => ({ id, dueDate });

  test('cuts the longer lookahead back to the bill window', () => {
    const rows = [row('a', '2026-08-20'), row('b', '2026-09-11'), row('c', '2026-10-30')];
    expect(withinDays(rows, '2026-08-12', 30).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('the horizon date itself is inside the window', () => {
    expect(withinDays([row('a', '2026-09-11')], '2026-08-12', 30)).toHaveLength(1);
    expect(withinDays([row('a', '2026-09-12')], '2026-08-12', 30)).toHaveLength(0);
  });

  /**
   * An occurrence stays `scheduled` until it is settled, so a bill three weeks
   * late is still something to cover this month. Dropping it would be the same
   * "the figure and the list describe different sets" defect from the other end.
   */
  test('overdue rows stay in every window', () => {
    expect(withinDays([row('a', '2026-01-01')], '2026-08-12', 30).map((e) => e.id)).toEqual(['a']);
  });

  test('an unparseable today keeps everything rather than emptying the screen', () => {
    const rows = [row('a', '2026-08-20')];
    expect(withinDays(rows, 'not-a-date', 30)).toEqual(rows);
  });
});

describe('occurrenceTotals', () => {
  const row = (amount: string | null, currencyTokenId: string, actual: string | null = null) => ({
    id: amount ?? 'none',
    dueDate: '2026-08-20',
    expectedAmount: amount,
    actualAmount: actual,
    payment: { direction: 'outflow', currencyTokenId },
  });

  const amounts = (totals: ReadonlyMap<string, { toString(): string }>) =>
    Object.fromEntries(Array.from(totals, ([token, total]) => [token, total.toString()]));

  test('sums the real instances in the window, per currency', () => {
    expect(amounts(occurrenceTotals([row('100', 'token-eur'), row('250.5', 'token-eur')]))).toEqual(
      {
        'token-eur': '350.5',
      }
    );
  });

  test('keeps the currencies apart — the conversion is V3-52 helpers, downstream', () => {
    expect(amounts(occurrenceTotals([row('100', 'token-eur'), row('900', 'token-usd')]))).toEqual({
      'token-eur': '100',
      'token-usd': '900',
    });
  });

  test('a variable payment with no estimate falls back to what was settled', () => {
    expect(amounts(occurrenceTotals([row(null, 'token-eur', '42')]))).toEqual({
      'token-eur': '42',
    });
  });

  test('nothing at all is an empty map, not a zero in an unknown currency', () => {
    expect(occurrenceTotals([]).size).toBe(0);
  });
});

/**
 * SC-78 §4. The merge picker was a `Select` whose option list opened upward
 * over the sheet header at a 32pt row pitch, on the one action that deletes a
 * vendor. Its replacement filters in place; this is the filter, and it is
 * deliberately no cleverer than a substring — `vendors.similar` owns
 * near-duplicate detection with measured thresholds (V3-49), and a fuzzy match
 * here would put a different vendor under the finger on a destructive control.
 */
describe('filtering the merge candidates', () => {
  const candidates = [
    { id: 'a', displayName: 'Acme GmbH' },
    { id: 'b', displayName: 'ACME Ltd' },
    { id: 'c', displayName: 'Hetzner Online' },
  ];

  test('an empty query keeps every candidate, in the order given', () => {
    expect(filterMergeCandidates(candidates, '').map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(filterMergeCandidates(candidates, '   ').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  test('matching ignores case and surrounding space', () => {
    expect(filterMergeCandidates(candidates, '  acme ').map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('matches anywhere in the name, not just the start', () => {
    expect(filterMergeCandidates(candidates, 'online').map((c) => c.id)).toEqual(['c']);
  });

  test('no match is an empty list, never a fuzzy guess on a delete control', () => {
    expect(filterMergeCandidates(candidates, 'hetznr')).toEqual([]);
  });

  test('never mutates the list it was handed', () => {
    const copy = [...candidates];
    filterMergeCandidates(candidates, 'acme');
    expect(candidates).toEqual(copy);
  });
});

// SC-83. Both delete confirmations are `ConfirmAction`s, and `ConfirmAction`'s
// own rule is that the consequence is required prose naming concrete counts —
// so the sentence IS the feature, and this is where it is under test rather
// than inside a component that needs a tRPC client to render.
describe('paymentDeleteCounts', () => {
  test('splits the three kinds, and counts anything unrecognised as settled', () => {
    expect(
      paymentDeleteCounts([
        { status: 'scheduled' },
        { status: 'scheduled' },
        { status: 'skipped' },
        { status: 'matched' },
        // `missed` is in the enum and nothing writes it yet. Counting it as
        // settled blocks a delete that might have been fine; counting it as
        // scheduled destroys a row nobody was asked about.
        { status: 'missed' },
      ])
    ).toEqual({ scheduled: 2, settled: 2, skipped: 1 });
  });

  test('no occurrences is three zeros, not a missing answer', () => {
    expect(paymentDeleteCounts([])).toEqual({ scheduled: 0, settled: 0, skipped: 0 });
  });
});

describe('paymentDeleteConsequence', () => {
  test('says it is still checking rather than guessing a count', () => {
    const sentence = paymentDeleteConsequence('Netflix', null, t);
    expect(sentence).toContain('Checking');
    expect(sentence).not.toMatch(/\d/);
  });

  test('a settled date turns the sentence into the reason it will not happen', () => {
    const sentence = paymentDeleteConsequence(
      'Netflix',
      {
        scheduled: 4,
        settled: 3,
        skipped: 0,
      },
      t
    );
    expect(sentence).toContain('3 dates settled');
    expect(sentence).toContain('money that really moved');
    // The refusal has to name the action that DOES fit, or it is a dead end.
    expect(sentence).toContain('End it instead');
  });

  /**
   * SC-113. The refusal's way out is a button now, so the sentence must not
   * name one that has already been taken.
   */
  test('a payment that has already ended is not told to end it instead', () => {
    const sentence = paymentDeleteConsequence(
      'Netflix',
      { scheduled: 0, settled: 3, skipped: 0 },
      t,
      true
    );
    expect(sentence).toContain('3 dates settled');
    expect(sentence).toContain('money that really moved');
    expect(sentence).not.toContain('End it instead');
    expect(sentence).toContain('already ended');
  });

  test('names what goes with it, with the verb agreeing with the whole subject', () => {
    expect(
      paymentDeleteConsequence('Netflix', { scheduled: 1, settled: 0, skipped: 0 }, t)
    ).toContain('1 date still scheduled goes with it');
    expect(
      paymentDeleteConsequence('Netflix', { scheduled: 1, settled: 0, skipped: 1 }, t)
    ).toContain('1 date still scheduled and 1 date you skipped go with it');
  });

  test('a payment with no occurrences at all still states the claim', () => {
    const sentence = paymentDeleteConsequence(
      'Netflix',
      {
        scheduled: 0,
        settled: 0,
        skipped: 0,
      },
      t
    );
    expect(sentence).toContain('as if it had never existed');
    expect(sentence).toContain('cannot be undone');
    // The distinction from End is the point of having both.
    expect(sentence).toContain('Use End instead');
  });
});

describe('vendorDeleteConsequence', () => {
  test('says it is still checking rather than guessing', () => {
    expect(vendorDeleteConsequence('Acme', null, t)).toContain('Checking');
  });

  test('a vendor with payments gets the count and both ways out', () => {
    const sentence = vendorDeleteConsequence(
      'Acme',
      {
        payments: 2,
        aliases: 0,
        extractions: 0,
      },
      t
    );
    expect(sentence).toContain('2 payments');
    expect(sentence).toContain('End or delete them first');
    expect(sentence).toContain('merge');
  });

  test('one payment reads as one payment, not "1 payments"', () => {
    const sentence = vendorDeleteConsequence(
      'Acme',
      {
        payments: 1,
        aliases: 0,
        extractions: 0,
      },
      t
    );
    expect(sentence).toContain('1 payment pointing at it');
    expect(sentence).not.toContain('1 payments');
  });

  test('names the extractions whose link is cut, since nothing else would', () => {
    const sentence = vendorDeleteConsequence(
      'Acme',
      {
        payments: 0,
        aliases: 2,
        extractions: 1,
      },
      t
    );
    expect(sentence).toContain('2 aliases');
    // ON DELETE SET NULL is silent — the SC-31 half that "succeeded".
    expect(sentence).toContain('1 parsed invoice keeps its own record');
    expect(sentence).toContain('cannot be undone');
  });

  test('a vendor nothing points at says exactly that', () => {
    const sentence = vendorDeleteConsequence(
      'Acme',
      {
        payments: 0,
        aliases: 0,
        extractions: 0,
      },
      t
    );
    expect(sentence).toContain('Nothing is paid to or by it');
    expect(sentence).not.toMatch(/\d/);
  });
});
