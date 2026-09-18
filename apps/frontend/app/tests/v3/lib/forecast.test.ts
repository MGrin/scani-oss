import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import {
  affordability,
  bucketMovements,
  DEFAULT_FORECAST_HORIZON,
  type ForecastMovementRow,
  materialCaveats,
  monthAfter,
  monthSequence,
  observedDecline,
  project,
  runway,
  windowTotals,
  withOneOff,
} from '@/v3/lib/forecast';
import type { ConversionContext } from '@/v3/lib/paymentTotals';

// Every assertion in this file is on the FIGURE, not on the shape of the
// series — "the projection returns twelve points" is true of a function that
// returns twelve zeros. The numbers below are what a reader would see on the
// screen for a portfolio somebody could describe out loud, including the two
// cases the ticket names: a PAUSED payment that must not appear, and a
// FOREIGN-currency one that must appear converted.

const EUR = 'token-eur';
const GBP = 'token-gbp';
const USD = 'token-usd';
const FRESH = '2026-03-01T06:00:00Z';
const NOW = new Date('2026-03-01T12:00:00Z');
const TODAY = '2026-03-04';

/** Base is EUR; GBP converts at 1.17, USD at 0.90. */
function ratesReady(overrides: Partial<ConversionContext> = {}): ConversionContext {
  return {
    baseCurrencyTokenId: EUR,
    ratesStatus: 'ready',
    rateByCurrencyTokenId: new Map([
      [GBP, { rate: '1.17', asOf: FRESH }],
      [USD, { rate: '0.9', asOf: FRESH }],
    ]),
    now: NOW,
    ...overrides,
  };
}

function movement(
  dueDate: string,
  amount: string,
  direction: 'outflow' | 'inflow' = 'outflow',
  currencyTokenId = EUR
): ForecastMovementRow {
  return { dueDate, amount, direction, currencyTokenId };
}

/** The window a reader gets by default: six months from March. */
function sixMonths(movements: readonly ForecastMovementRow[]) {
  return bucketMovements(movements, monthSequence(TODAY, DEFAULT_FORECAST_HORIZON));
}

describe('monthSequence', () => {
  test('starts with the month we are in and rolls the year', () => {
    expect(monthSequence('2026-11-20', 4)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  test('the default window is six months', () => {
    expect(DEFAULT_FORECAST_HORIZON).toBe(6);
    expect(monthSequence(TODAY, DEFAULT_FORECAST_HORIZON)).toHaveLength(6);
  });
});

describe('bucketMovements', () => {
  test('a quiet month is a bucket, not a hole', () => {
    const buckets = sixMonths([movement('2026-05-15', '100')]);
    expect(buckets.map((bucket) => bucket.key)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
    expect(buckets[0]?.outflow.size).toBe(0);
    expect(buckets[2]?.outflow.get(EUR)?.toString()).toBe('100');
  });

  test('outflow and inflow never mix, and each keeps its own currency', () => {
    const buckets = sixMonths([
      movement('2026-03-10', '1200', 'outflow', EUR),
      movement('2026-03-15', '4000', 'inflow', GBP),
      movement('2026-03-20', '90', 'outflow', GBP),
    ]);
    expect(buckets[0]?.outflow.get(EUR)?.toString()).toBe('1200');
    expect(buckets[0]?.outflow.get(GBP)?.toString()).toBe('90');
    expect(buckets[0]?.inflow.get(GBP)?.toString()).toBe('4000');
    expect(buckets[0]?.inflow.get(EUR)).toBeUndefined();
  });
});

describe('the projected balance a reader would see', () => {
  // €10,000 liquid, €1,000 of rent a month, £500 of income a month.
  // £500 × 1.17 = €585, so the book nets −€415 a month.
  const opening = new Decimal('10000');
  const book = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].flatMap(
    (month) => [
      movement(`${month}-01`, '1000', 'outflow', EUR),
      movement(`${month}-15`, '500', 'inflow', GBP),
    ]
  );

  test('a foreign-currency payment is converted into the figure, not listed beside it', () => {
    const projection = project(opening, sixMonths(book), ratesReady());

    expect(projection.pending).toBe(false);
    expect(projection.unconverted).toEqual([]);
    // Month one: 10000 − 1000 + 585.
    expect(projection.points[0]?.balance.toString()).toBe('9585');
    expect(projection.points[0]?.inflow.toString()).toBe('585');
    // Six months of −415.
    expect(projection.points.at(-1)?.balance.toString()).toBe('7510');
  });

  test('a paused payment is absent from the figure — the whole projection moves without it', () => {
    // `payments.forecast` drops paused payments server-side (see
    // `buildForecast`), so the wire carries no movement for one. This is the
    // client half of the same claim: the number the reader sees is the number
    // WITHOUT it, and it differs from the number with it. Asserting only that
    // a paused row is missing from a list would pass while the total below the
    // list still counted it.
    const withoutPaused = project(opening, sixMonths(book), ratesReady());
    const pausedRentToo = book.concat(
      ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((month) =>
        movement(`${month}-05`, '300', 'outflow', EUR)
      )
    );
    const withPaused = project(opening, sixMonths(pausedRentToo), ratesReady());

    expect(withoutPaused.points.at(-1)?.balance.toString()).toBe('7510');
    expect(withPaused.points.at(-1)?.balance.toString()).toBe('5710');
  });

  test('a currency with no rate is left out of the figure AND named', () => {
    const projection = project(
      opening,
      sixMonths([
        movement('2026-03-01', '1000', 'outflow', EUR),
        movement('2026-04-01', '200', 'outflow', USD),
      ]),
      ratesReady({ rateByCurrencyTokenId: new Map([[USD, null]]) })
    );

    expect(projection.points.at(-1)?.balance.toString()).toBe('9000');
    expect(projection.unconverted).toEqual([{ currencyTokenId: USD, amount: new Decimal('200') }]);
  });

  test('a projection computed before the rates land is reported pending, not rendered', () => {
    // SC-210, one surface further out: without the rates the burn is the
    // base-currency part alone, so the balance is too high and the runway too
    // long. The caller shows a skeleton.
    const projection = project(
      opening,
      sixMonths([movement('2026-03-15', '4000', 'outflow', GBP)]),
      ratesReady({ rateByCurrencyTokenId: new Map(), ratesStatus: 'loading' })
    );
    expect(projection.pending).toBe(true);
  });
});

describe('runway', () => {
  const opening = new Decimal('3000');

  test('names the month the balance runs out, counting from now', () => {
    // €1,000 a month against €3,000: the balance is 0 at the end of month
    // three, which is May — index 2, "in 2 months".
    const projection = project(
      opening,
      sixMonths(
        ['2026-03', '2026-04', '2026-05', '2026-06'].map((month) => movement(`${month}-10`, '1000'))
      ),
      ratesReady()
    );
    const answer = runway(projection);

    expect(answer).toEqual({ kind: 'exhausted', month: '2026-05', monthsFromNow: 2 });
  });

  test('a book that never runs out gets a window and a rate, never an extrapolated date', () => {
    const projection = project(
      opening,
      sixMonths(
        ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((month) =>
          movement(`${month}-10`, '100', 'inflow', EUR)
        )
      ),
      ratesReady()
    );
    const answer = runway(projection);

    expect(answer.kind).toBe('lasts');
    if (answer.kind !== 'lasts') throw new Error('unreachable');
    expect(answer.beyondMonths).toBe(6);
    expect(answer.netPerMonth.toString()).toBe('100');
  });

  test('a balance that is already zero runs out in the month we are in', () => {
    const projection = project(
      new Decimal('0'),
      sixMonths([movement('2026-03-10', '10')]),
      ratesReady()
    );
    expect(runway(projection)).toEqual({
      kind: 'exhausted',
      month: '2026-03',
      monthsFromNow: 0,
    });
  });
});

describe('can I afford it', () => {
  // €6,000 liquid, €1,000 a month going out: runs out at the end of month six.
  const opening = new Decimal('6000');
  const book = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((month) =>
    movement(`${month}-10`, '1000')
  );

  test('a one-off lands in its own month and shortens the runway by the months it costs', () => {
    const buckets = sixMonths(book);
    const before = project(opening, buckets, ratesReady());
    const after = project(
      opening,
      withOneOff(buckets, { date: '2026-04-20', currencyTokenId: EUR, amount: '2000' }),
      ratesReady()
    );
    const answer = affordability(before, after);

    expect(answer.runwayBefore).toEqual({
      kind: 'exhausted',
      month: '2026-08',
      monthsFromNow: 5,
    });
    expect(answer.runwayAfter).toEqual({ kind: 'exhausted', month: '2026-06', monthsFromNow: 3 });
    expect(answer.monthsLost).toBe(2);
    expect(answer.affordable).toBe(false);
  });

  test('a one-off in a foreign currency is converted before it is asked about', () => {
    const buckets = sixMonths(book);
    const after = project(
      opening,
      // £1,000 is €1,170 — enough to cost a month where £1,000 read as €1,000
      // would not.
      withOneOff(buckets, { date: '2026-03-20', currencyTokenId: GBP, amount: '1000' }),
      ratesReady()
    );
    expect(after.points[0]?.balance.toString()).toBe('3830');
  });

  test('affordable means the balance never goes below zero, and names the low point', () => {
    const buckets = sixMonths([
      movement('2026-03-10', '1000'),
      movement('2026-06-10', '3000', 'inflow', EUR),
    ]);
    const before = project(opening, buckets, ratesReady());
    const after = project(
      opening,
      withOneOff(buckets, { date: '2026-04-01', currencyTokenId: EUR, amount: '4000' }),
      ratesReady()
    );
    const answer = affordability(before, after);

    expect(answer.affordable).toBe(true);
    expect(answer.lowest).toEqual({ month: '2026-04', balance: new Decimal('1000') });
    // Neither walk runs out inside the window, so there is no number of months
    // to quote and the surface has to print the two answers instead.
    expect(answer.monthsLost).toBeNull();
  });

  test('the one-off never mutates the projection it is compared against', () => {
    const buckets = sixMonths(book);
    withOneOff(buckets, { date: '2026-03-20', currencyTokenId: EUR, amount: '5000' });
    expect(buckets[0]?.outflow.get(EUR)?.toString()).toBe('1000');
  });
});

describe('windowTotals', () => {
  test('sums each side over the whole window, per currency', () => {
    const totals = windowTotals(
      sixMonths([
        movement('2026-03-01', '1000', 'outflow', EUR),
        movement('2026-05-01', '1000', 'outflow', EUR),
        movement('2026-04-01', '90', 'outflow', GBP),
        movement('2026-06-01', '4000', 'inflow', GBP),
      ])
    );
    expect(totals.outflow.get(EUR)?.toString()).toBe('2000');
    expect(totals.outflow.get(GBP)?.toString()).toBe('90');
    expect(totals.inflow.get(GBP)?.toString()).toBe('4000');
  });
});

describe('monthAfter', () => {
  test('counts calendar months from the one today falls in, across a year end', () => {
    expect(monthAfter('2026-03-04', 0)).toBe('2026-03');
    expect(monthAfter('2026-03-04', 11)).toBe('2027-02');
    expect(monthAfter('2026-12-31', 1)).toBe('2027-01');
  });
});

describe('observedDecline', () => {
  /**
   * The claim is that the money is GONE, not that it goes below zero by
   * exactly one month's spending. A stray negative also drags
   * `ProjectionChart`'s y-axis — anchored at `min(0, …balances)` — down to a
   * rounded tick, which spent a third of the chart on empty space under the
   * answer.
   */
  test('ends exactly at zero on the month the balance is spent', () => {
    const points = observedDecline('10000', '4000', '2026-03-04', 2);
    expect(points.map((point) => point.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(points.map((point) => point.balance.toString())).toEqual(['6000', '2000', '0']);
    // The last month cannot spend a full month's drain out of a balance that
    // no longer holds one, and the tooltip reads this figure.
    expect(points.map((point) => point.outflow.toString())).toEqual(['4000', '4000', '2000']);
  });

  test('the last month is the one the runway sentence names', () => {
    const months = 2;
    const points = observedDecline('10000', '4000', '2026-03-04', months);
    expect(points.at(-1)?.month).toBe(monthAfter('2026-03-04', months + 1));
  });

  test('credits no inflow — observed burn is already a net departure rate', () => {
    const points = observedDecline('9000', '3000', '2026-03-04', 3);
    expect(points.every((point) => point.inflow.isZero())).toBe(true);
  });
});

/**
 * THE SEAM, EXECUTED — the show/hide table in
 * `docs/technical/2026-09-06_sc1068-forecast-materiality-seam.md`, so the
 * document cannot drift from the rule it describes.
 *
 * Every figure here is SYNTHETIC and was invented to span the cases. The
 * profiles differ in exactly one dimension each, which is what makes a row
 * evidence rather than an illustration: A shows on all three arms, B on none,
 * C only on illiquid, D only on the unknown-magnitude arm.
 */
describe('materialCaveats', () => {
  const profile = (over: Partial<Parameters<typeof materialCaveats>[0]> = {}) =>
    materialCaveats({
      liquid: { amount: '120000', illiquid: { count: 2, amount: '45000' } },
      perMonth: '9000',
      perMonthMedian: '5000',
      notCountedOutflows: 3,
      denominatorIsMeasured: true,
      ...over,
    });

  const kinds = (list: ReturnType<typeof materialCaveats>) => list.map((entry) => entry.kind);

  test('A — a swingy book raises all three', () => {
    expect(kinds(profile()).sort()).toEqual(['illiquid', 'notCounted', 'spread']);
  });

  test('B — a tight book raises none, which is the case the rule exists for', () => {
    expect(
      kinds(
        profile({
          liquid: { amount: '18000', illiquid: { count: 1, amount: '1200' } },
          perMonth: '3000',
          perMonthMedian: '2900',
          notCountedOutflows: 0,
        })
      )
    ).toEqual([]);
  });

  test('C — a property position that dwarfs the balance shows', () => {
    expect(
      kinds(
        profile({
          liquid: { amount: '40000', illiquid: { count: 1, amount: '300000' } },
          perMonth: '2500',
          perMonthMedian: '2400',
          notCountedOutflows: 0,
        })
      )
    ).toEqual(['illiquid']);
  });

  /**
   * D against C is the pair that matters: the same KIND of caveat, separated
   * with no percentage anywhere. C is worth 120 months of burn and shows; D is
   * worth 0.4 of one and does not.
   */
  test('D — a small illiquid position does not, and nothing else about it changed', () => {
    expect(
      kinds(
        profile({
          liquid: { amount: '90000', illiquid: { count: 1, amount: '3000' } },
          perMonth: '8000',
          perMonthMedian: '7600',
          notCountedOutflows: 1,
        })
      )
    ).toEqual(['notCounted']);
  });

  /**
   * The threshold is the answer's own unit, so the boundary is exactly one
   * month of burn and it is inclusive: a caveat worth precisely one month can
   * move a figure printed in whole months.
   */
  test('the boundary is one month of burn, inclusive', () => {
    const at = profile({
      liquid: { amount: '90000', illiquid: { count: 1, amount: '8000' } },
      perMonth: '8000',
      perMonthMedian: '8000',
      notCountedOutflows: 0,
    });
    const under = profile({
      liquid: { amount: '90000', illiquid: { count: 1, amount: '7999.99' } },
      perMonth: '8000',
      perMonthMedian: '8000',
      notCountedOutflows: 0,
    });
    expect(kinds(at)).toEqual(['illiquid']);
    expect(kinds(under)).toEqual([]);
  });

  /**
   * Arm 2, and the asymmetry is the whole of it. Unpriced holdings are not
   * even an input here: counting them can only LENGTHEN the runway, so the
   * stated figure is a floor and the reader is not misled by acting on it.
   * Unanswered outflows can only shorten it, so any at all is material.
   */
  test('an unknown magnitude that can only shorten the runway is material at one row', () => {
    expect(
      kinds(
        profile({
          liquid: { amount: '18000', illiquid: { count: 0, amount: '0' } },
          perMonth: '3000',
          perMonthMedian: '3000',
          notCountedOutflows: 1,
        })
      )
    ).toEqual(['notCounted']);
  });

  /**
   * There is no denominator, so there is no question to answer. Returning an
   * empty list rather than every caveat is the same rule
   * `projectedShareOfObserved` follows: a share of nothing is not zero.
   */
  test('no burn means no seam — nothing is material against a denominator that does not exist', () => {
    expect(kinds(profile({ perMonth: null }))).toEqual([]);
  });

  /**
   * The spread arm asks whether the MEDIAN of those months would give a
   * different answer than their MEAN. Under an override the user has replaced
   * the statistic, so their figure against the measured median compares two
   * different things — and raises the caveat on the strength of their own
   * correction. Found by exercising it in a browser: an override near three
   * times the measured mean surfaced "those months ranged …" beside a runway
   * that no longer had anything to do with those months.
   *
   * The control is the first assertion: the SAME numbers with the denominator
   * measured DO raise it, so the absence below is this guard rather than the
   * arm failing to fire.
   */
  test("the spread arm is silent when the denominator is the user's own figure", () => {
    const over = {
      liquid: { amount: '220000', illiquid: { count: 0, amount: '0' } },
      perMonth: '25000',
      perMonthMedian: '7552',
      notCountedOutflows: 0,
    };
    expect(kinds(profile({ ...over, denominatorIsMeasured: true }))).toEqual(['spread']);
    expect(kinds(profile({ ...over, denominatorIsMeasured: false }))).toEqual([]);
  });
});
