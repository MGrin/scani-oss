import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import {
  affordability,
  bucketMovements,
  DEFAULT_FORECAST_HORIZON,
  type ForecastMovementRow,
  monthSequence,
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
