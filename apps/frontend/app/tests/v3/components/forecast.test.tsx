import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import {
  buildForecast,
  type ForecastPaymentInput,
} from '../../../../../../packages/business/domain/src/services/payments/forecast';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { ForecastView } from '../../../src/v3/components/money/ForecastView';

/**
 * SC-461, end to end on the number a person would actually read.
 *
 * The book below goes through the REAL server-side expansion —
 * `buildForecast`, imported by path because it is a pure module with no
 * database behind it — and its output is handed to the view exactly as the
 * wire would. So a break in either half moves the string this file asserts on,
 * which is what makes it worth writing: a test that asserted "the projection
 * returns six points" would pass over a paused rent still being charged and
 * over a sterling invoice counted as euros.
 *
 * The two cases the ticket names are both here, and both are checked by the
 * figure moving, never by a row being absent from a list:
 *
 * - a PAUSED payment, with materialised `scheduled` rows still in the table
 *   (which is what `pause` really leaves behind), must change nothing;
 * - a GBP invoice must arrive in the figure CONVERTED, not listed beside it.
 */

const EUR = 'token-eur';
const GBP = 'token-gbp';
const TODAY = '2026-03-04';
/** Twelve months, the window `PaymentForecastService` always answers for. */
const HORIZON_END = '2027-03-04';

const SYMBOLS = new Map([
  [EUR, 'EUR'],
  [GBP, 'GBP'],
]);

const rates = (over: Partial<BaseCurrencyRates> = {}): BaseCurrencyRates => ({
  baseCurrencyTokenId: EUR,
  baseSymbol: 'EUR',
  // £1 = €1.17.
  rateByCurrencyTokenId: new Map([[GBP, { rate: '1.17', asOf: '2026-03-04T06:00:00Z' }]]),
  ratesStatus: 'ready',
  ...over,
});

const READY = {
  isLoading: false,
  isError: false,
  error: null,
  retry: () => {},
  more: null,
};

function payment(over: Partial<ForecastPaymentInput['payment']>): ForecastPaymentInput['payment'] {
  return {
    id: 'pay',
    direction: 'outflow',
    currencyTokenId: EUR,
    expectedAmount: '0',
    intervalUnit: 'month',
    intervalCount: 1,
    anchorDate: '2026-03-10',
    status: 'active',
    endDate: null,
    ...over,
  };
}

/** Materialised `scheduled` rows for the next twelve months, on the 10th. */
function scheduledYear(amount: string) {
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 2 + index, 10));
    return {
      dueDate: date.toISOString().slice(0, 10),
      status: 'scheduled',
      expectedAmount: amount,
    };
  });
}

/**
 * A contractor's book, which is the reader this ticket names: lumpy income in
 * one currency, fixed costs in another.
 *
 * - rent, €1,200 a month, running;
 * - a £300-a-month desk, running — a fixed cost in the OTHER currency, which
 *   is the half of the reader's problem an inflow-only fixture cannot see;
 * - a £2,000-a-month retainer coming IN;
 * - a €400-a-month gym membership, PAUSED, with its rows still in the table;
 * - a variable utility bill with no estimate.
 *
 * Net, monthly: −1200 − (300 × 1.17) + (2000 × 1.17) = **+€789**. With the
 * paused gym wrongly counted it is +€389; with sterling read as euros it is
 * +€500. Three different numbers, so the assertions below can only be
 * satisfied by getting both rules right — and the conversion has to be applied
 * on BOTH sides, since dropping it on the outflow alone changes the answer
 * too.
 */
const BOOK: ForecastPaymentInput[] = [
  {
    payment: payment({ id: 'rent', expectedAmount: '1200' }),
    occurrences: scheduledYear('1200'),
  },
  {
    payment: payment({ id: 'desk', currencyTokenId: GBP, expectedAmount: '300' }),
    occurrences: scheduledYear('300'),
  },
  {
    payment: payment({
      id: 'retainer',
      direction: 'inflow',
      currencyTokenId: GBP,
      expectedAmount: '2000',
    }),
    occurrences: scheduledYear('2000'),
  },
  {
    payment: payment({ id: 'gym', status: 'paused', expectedAmount: '400' }),
    occurrences: scheduledYear('400'),
  },
  {
    payment: payment({ id: 'utilities', expectedAmount: null }),
    occurrences: scheduledYear(null as unknown as string),
  },
];

function wire(book: ForecastPaymentInput[], liquidAmount: string) {
  const forecast = buildForecast(book, TODAY, HORIZON_END);
  return {
    ...forecast,
    today: TODAY,
    horizonEnd: HORIZON_END,
    horizonMonths: 12,
    liquid: {
      amount: liquidAmount,
      baseCurrency: 'EUR',
      countedHoldings: 4,
      illiquid: { count: 1, amount: '250000' },
      unpriceable: { count: 0 },
    },
  };
}

function render(book: ForecastPaymentInput[], liquidAmount: string, over = {}) {
  return renderToStaticMarkup(
    <StaticRouter location="/payments/forecast">
      <ForecastView
        // biome-ignore lint/suspicious/noExplicitAny: the wire type is inferred
        // from the tRPC router, which a component test cannot reach; the shape
        // is built from the real `buildForecast` output above.
        forecast={wire(book, liquidAmount) as any}
        tokenSymbolById={SYMBOLS}
        rates={rates()}
        query={READY}
        paymentCount={book.length}
        tokens={[]}
        {...over}
      />
    </StaticRouter>
  );
}

describe('the cashflow forecast, as it is rendered', () => {
  test('a paused payment does not move the projected balance', () => {
    // €10,000 liquid, +€789 a month for six months → €14,734 at the end of
    // the default window. Counting the paused €400 gym would print €12,334.
    const html = render(BOOK, '10000');

    expect(html).toInclude('€14,734.00');
    expect(html).not.toInclude('€12,334.00');
  });

  test('the paused payment really is in the data — the control for the test above', () => {
    // Without this, the assertion above passes on a `buildForecast` that
    // returns nothing at all, and on a fixture where the gym was never there.
    // Flip it to active and the figure moves by exactly the gym's six months.
    const active = BOOK.map((entry) =>
      entry.payment.id === 'gym'
        ? { ...entry, payment: { ...entry.payment, status: 'active' } }
        : entry
    );
    expect(render(active, '10000')).toInclude('€12,334.00');
  });

  test('sterling arrives converted on BOTH sides, not listed beside the figures', () => {
    const html = render(BOOK, '10000');

    // €14,734 can only be reached through the rate: at 1:1 the same book gives
    // €13,000, and that number must appear nowhere on the surface.
    expect(html).toInclude('€14,734.00');
    expect(html).not.toInclude('€13,000.00');

    // Income: £12,000 over six months at 1.17. At 1:1 it would read €12,000.
    expect(html).toInclude('+€14,040.00');
    expect(html).not.toInclude('€12,000.00');

    // Outgoings: €7,200 of rent plus £1,800 of desk at 1.17 = €9,306. Dropping
    // the rate on this side alone gives €9,000 — the figure that proves the
    // conversion is not applied to income only.
    expect(html).toInclude('€9,306.00');
    expect(html).not.toInclude('€9,000.00');

    // And both conversions are SAID, in the captions `<ConvertedTotal>` prints:
    // one number above, the sterling part that went through a rate underneath.
    expect(html).toInclude('£12,000.00');
    expect(html).toInclude('£1,800.00');
    expect(html).toInclude('converted at rates from');
  });

  test('the variable payment with no estimate is counted out loud', () => {
    const html = render(BOOK, '10000');
    expect(html).toInclude('Not in this projection');
    expect(html).toInclude('1 variable payment has no estimate');
  });

  test('the runway names a month when the book is losing money', () => {
    // Rent only, no retainer: €3,600 liquid against €1,200 a month runs out at
    // the end of the third month, which is May 2026.
    const rentOnly = BOOK.filter((entry) => entry.payment.id === 'rent');
    const html = render(rentOnly, '3600');

    expect(html).toInclude('Runs out in May 2026');
  });

  test('a book that never runs out gets a window and a rate, not a date', () => {
    const html = render(BOOK, '10000');
    expect(html).toInclude('Lasts beyond 12 months');
    expect(html).not.toInclude('Runs out in');
    // What it is doing, so "beyond 12 months" is not the whole answer.
    expect(html).toInclude('+€789.00');
  });

  test('the liquid figure names what it counted and what it set aside', () => {
    // mgrin took the broadest definition of liquid, so the denominator is part
    // of the claim rather than a footnote.
    const html = render(BOOK, '10000');
    expect(html).toInclude('€10,000.00');
    expect(html).toInclude('across 4 holdings');
    expect(html).toInclude('€250,000.00');
    expect(html).toInclude('left out as illiquid');
  });

  test('every figure on the surface is marked as a projection', () => {
    const html = render(BOOK, '10000');
    // On each tile, not once at the top of the screen — a caveat that scrolls
    // away from its figure is not a caveat. Runway, end balance, out, in.
    expect(html.match(/Projected/g)?.length).toBeGreaterThanOrEqual(4);
    // And the blocks are dashed, which is the mark the chart line shares.
    expect(html).toInclude('border-dashed');
  });

  test('both empty states render sentences, not i18n keys', () => {
    // `DataViewEmpty` takes KEYS, and a wrong namespace renders the key itself
    // — `ui.dataView.forecast.empty.noPayments` in 13px grey, on the screen of
    // somebody who has just arrived. These two keys live in the SHELL locale
    // file rather than the v3 one (that is where `ui.dataView.*` lives), which
    // is exactly the kind of split a reader gets wrong once.
    const bare = render([], '0');
    expect(bare).not.toInclude('ui.dataView.forecast');
    expect(bare).toInclude('No recurring payments yet');

    // Payments exist but none of them can be projected — a different sentence,
    // because "you have none" and "yours cannot be projected" are different
    // facts and only one of them is the reader's to fix.
    const allPaused = BOOK.map((entry) => ({
      ...entry,
      payment: { ...entry.payment, status: 'paused' },
    }));
    const stalled = render(allPaused, '10000');
    expect(stalled).not.toInclude('ui.dataView.forecast');
    expect(stalled).toInclude('Nothing to project');
    expect(stalled).toInclude('paused, ended, or has no amount');
  });

  test('nothing is rendered as a figure while the rates are still coming', () => {
    // SC-210 one surface further out: the burn would be missing its sterling
    // half, so the balance is too high and the runway too long.
    const html = render(BOOK, '10000', {
      rates: rates({ rateByCurrencyTokenId: new Map(), ratesStatus: 'loading' }),
    });
    expect(html).not.toInclude('Lasts beyond');
    expect(html).not.toInclude('€14,734.00');
    expect(html).toInclude('Working it out…');
  });
});
