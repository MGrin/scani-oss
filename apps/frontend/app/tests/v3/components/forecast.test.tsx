import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import {
  buildForecast,
  type ForecastPaymentInput,
} from '../../../../../../packages/business/domain/src/services/payments/forecast';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { trpc } from '../../../src/lib/trpc';
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

/**
 * An `observedBurn` payload, SC-661. €1,250 a month against €10,000 liquid is
 * eight months — deliberately DIFFERENT from anything the book produces, so an
 * assertion on "8 months" cannot be satisfied by the committed walk.
 */
function observedBurn(over: Record<string, unknown> = {}) {
  return {
    windowMonths: 6,
    fromMonth: '2025-09',
    toMonth: '2026-02',
    perMonth: [],
    total: '7500',
    perMonthMean: '1250',
    perMonthMedian: '1100',
    perMonthMin: '400',
    perMonthMax: '3000',
    countedTransactions: 14,
    excluded: { unclassified: 2, untracked: 1, internal: 0, unvalued: 0 },
    // The production shape, scaled to this fixture's 7500 total: user a
    // minority BY VALUE, no automated rows at all, unattributed the bulk.
    provenance: { user: '1775', automated: '0', unattributed: '5725' },
    staleValued: 0,
    ...over,
  };
}

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
    // Non-optional on the wire (SC-661): the router always sends a state, and
    // `none` is the state of an account that has said nothing. Defaulted here
    // rather than made optional in the component, so a payload that really did
    // omit it stays a failure rather than a silently empty affordance.
    observedBurnAnswer: { kind: 'none' as const },
  };
}

/**
 * The affordance added in SC-661 mutates, so the subtree now reaches for tRPC.
 * No request is made in a static render — the provider exists so the hooks can
 * resolve a context, which is what the rest of this file is about rather than
 * the network.
 */
function render(book: ForecastPaymentInput[], liquidAmount: string, over = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>
    </trpc.Provider>
  );
}

/**
 * SC-661. The page's HERO is the observed figure, and it is the same figure
 * the home line renders.
 *
 * The two surfaces used to answer this question separately and reached
 * OPPOSITE conclusions on one account at one instant: home read "About 27
 * months at recent spending", the page read "Lasts beyond 12 months, the book
 * nets a large positive figure a month". The book is not a second opinion — on the real
 * account it records the income and almost none of the spending, so projected
 * forward it says the money grows forever.
 */
describe('SC-661 — the forecast page leads with observed burn', () => {
  test('the hero is the observed runway, not the book walked forward', () => {
    // €10,000 ÷ €1,250 a month = 8. The BOOK on this fixture nets +€789 a
    // month and never runs out, so "Lasts beyond 12 months" is what the old
    // hero printed — asserting its ABSENCE is what makes this test about the
    // swap rather than about a string appearing somewhere on a long page.
    const html = render(BOOK, '10000', {
      forecast: { ...wire(BOOK, '10000'), observedBurn: observedBurn() },
    });

    expect(html).toInclude('About 8 months at recent spending');
    expect(html).not.toInclude('Lasts beyond 12 months');
    expect(html).not.toInclude('The book nets');
  });

  test('the committed book keeps its own block, under a name that is not runway', () => {
    const html = render(BOOK, '10000', {
      forecast: { ...wire(BOOK, '10000'), observedBurn: observedBurn() },
    });

    // Demoted, not deleted: an observed month says nothing about how much of
    // it could be STOPPED, and the book is the only thing that does.
    // Asserted on the note rather than the heading because React escapes the
    // apostrophe in "What's committed" to `&#x27;`, and a test that matches
    // the source spelling fails on markup that is perfectly correct.
    expect(html).toInclude('Your recurring book alone');
    expect(html).toInclude('€14,734.00');
  });

  test('the figure carries its spread and what it could not count', () => {
    const html = render(BOOK, '10000', {
      forecast: { ...wire(BOOK, '10000'), observedBurn: observedBurn() },
    });

    // The window, the statistic BY NAME, the range, and the middle month.
    //
    // Naming the statistic is not pedantry. Measured on the real book, the
    // mean is 1.86x the median — $13,984 against $7,505 — so "about 8 months"
    // and "about 15 months" are the same data read two ways. A figure that far
    // from a typical month has to say which one it is, or it alarms the reader
    // about a distribution while sounding like a trend.
    expect(html).toInclude('Mean of 6 complete months, 2025-09 to 2026-02');
    expect(html).toInclude('€400.00');
    expect(html).toInclude('€3,000.00');
    expect(html).toInclude('€1,100.00');
    // 2 unclassified + 1 untracked + 0 unvalued. Treated as zero in the mean,
    // so the runway is too long by however much they were — the flattering
    // direction, which is why the count is printed rather than folded away.
    expect(html).toInclude('3 outflows are not counted');
  });

  /**
   * `committedShareOfObserved` can exceed 1 and `burn.ts` forbids clamping it:
   * a book committing more per month than actually left the perimeter is a
   * real state — the book is stale, or the month was funded from cash already
   * outside — and clamping to 100% would hide exactly the divergence that
   * showing two figures exists to reveal.
   *
   * This fixture is that case: €1,551 a month committed against a €1,250
   * observed mean.
   */
  test('a committed share above 100% is printed, not clamped', () => {
    const html = render(BOOK, '10000', {
      forecast: { ...wire(BOOK, '10000'), observedBurn: observedBurn() },
    });

    expect(html).toInclude('~124% of that spending is committed');
    expect(html).not.toInclude('~100% of that spending is committed');
  });

  /**
   * The fourth SC-661 finding. `RunwayLine`'s observed path has no `movements`
   * guard, so an account with perimeter exits and no recurring payments got a
   * runway on the home screen and "no payments recorded" on the page it linked
   * to — the two screens disagreeing about whether the feature exists, which
   * is worse than disagreeing about a figure.
   */
  test('an empty book with observed burn is answered, not sent to the empty state', () => {
    const html = render([], '10000', {
      forecast: { ...wire([], '10000'), observedBurn: observedBurn() },
      paymentCount: 0,
    });

    expect(html).toInclude('About 8 months at recent spending');
    expect(html).not.toInclude('Add a payment');
    // And the committed block is gone rather than rendering a flat chart and
    // two zeroes under a heading that promises a schedule.
    expect(html).not.toInclude('Your recurring book alone');
  });

  test('an empty book with NO observed burn still gets the empty state', () => {
    // The control for the test above: the relaxation is conditional, not a
    // removal, so a genuinely empty account must still be told so.
    const html = render([], '10000', { paymentCount: 0 });

    expect(html).not.toInclude('at recent spending');
  });
});

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

/**
 * SC-661/SC-673. The caption that says WHO classified the money the burn is
 * made of.
 */
describe('SC-661 — provenance of the counted burn', () => {
  const withBurn = () => ({
    forecast: { ...wire(BOOK, '10000'), observedBurn: observedBurn() },
  });

  test('the shares are by VALUE, and the middle class is absent when it is zero', () => {
    const html = render(BOOK, '10000', withBurn());

    // 1775 / 7500 = 24%, 5725 / 7500 = 76%. Deliberately the production shape:
    // a count-weighted implementation would report different numbers, and no
    // count is available to render even by accident.
    expect(html).toInclude('24% of that value rests on answers you gave');
    expect(html).toInclude('76% carries no record of who or what decided');
    expect(html).not.toInclude('decided by a named rule');
  });

  /**
   * The middle class is not dead code. It renders empty within the burn
   * window's `left_control` rows on the one production book we have, and is
   * NOT empty book-wide — 30 rows there decode as `repair`. This is its
   * control: given a non-zero automated share it must appear.
   */
  test('a named mechanism is named when there is one', () => {
    const html = render(BOOK, '10000', {
      forecast: {
        ...wire(BOOK, '10000'),
        observedBurn: observedBurn({
          provenance: { user: '1500', automated: '3000', unattributed: '3000' },
        }),
      },
    });

    expect(html).toInclude('40% was decided by a named rule you can go and read');
    expect(html).toInclude('20% of that value rests on answers you gave');
  });

  /**
   * THE GUARD IS ON THE AMOUNT AND THE SENTENCE PRINTS A PERCENT.
   *
   * A class whose amount is positive but under half a percent of the total
   * passed `greaterThan(0)` and printed "0% of that value rests on answers you
   * gave." — a measurement asserting zero, which is worse than the silence the
   * guard exists to produce. Absent says nothing; `0%` says something false.
   *
   * IT COULD NOT APPEAR ON THE BOOK THIS SHIPPED AGAINST, which is why it
   * reached production: `automated` is exactly 0 there, so it takes the null
   * branch. Separating "renders when the amount is > 0" from "renders when the
   * PRINTED figure is > 0" needs a value both positive and tiny, and only a
   * fixture has one.
   *
   * The negative assertion is the one that would have been red. The positive
   * one alone would pass on an implementation that suppressed the class
   * entirely — and suppressing it asserts the class contributed NOTHING, the
   * same false claim in the other direction.
   */
  test('a positive share too small to round to 1% prints <1%, never 0%', () => {
    const html = render(BOOK, '10000', {
      forecast: {
        ...wire(BOOK, '10000'),
        // 10 / 7500 = 0.133%, which `toFixed(0)` renders as "0".
        observedBurn: observedBurn({
          provenance: { user: '7480', automated: '10', unattributed: '10' },
        }),
      },
    });

    // `&lt;` because this is serialized HTML — the DOM text is `<1%`. Asserted
    // in the escaped form rather than stripped, so the NEXT line can be the
    // one that matters: the marker travels through i18next interpolation AND
    // React, and a double escape would put the literal characters `&lt;1%` on
    // the user's screen. `&amp;lt;` is what that looks like here.
    expect(html).toInclude('&lt;1% was decided by a named rule you can go and read');
    expect(html).toInclude('&lt;1% carries no record of who or what decided');
    expect(html).not.toInclude('&amp;lt;');

    expect(html).not.toInclude('>0% was decided by a named rule');
    expect(html).not.toInclude('>0% carries no record of who or what decided');
    // Control: the class that DOES round is untouched, so the assertions above
    // are the `<1` branch firing rather than the block failing to render.
    expect(html).toInclude('100% of that value rests on answers you gave');
  });

  /**
   * PLACEMENT IS PART OF THE FIX. The excluded line is a small caveat about 4
   * EXCLUDED rows; this is a large claim about 76% of the value that IS
   * COUNTED. Opposite operations — adjacent and in the wrong order, the larger
   * claim reads as a footnote to the smaller one and a reader who has just been
   * told some rows were left out stops there.
   */
  test('provenance comes BEFORE the excluded-rows sentence', () => {
    const html = render(BOOK, '10000', withBurn());
    const provenance = html.indexOf('Who classified the money');
    const excluded = html.indexOf('outflows are not counted');

    expect(provenance).toBeGreaterThan(-1);
    expect(excluded).toBeGreaterThan(-1);
    expect(provenance).toBeLessThan(excluded);
  });

  /**
   * A share of nothing is not three zeroes, it is a question with no answer —
   * the same rule `committedShareOfObserved` follows. A window with no counted
   * exits says nothing rather than printing confident zeroes.
   */
  test('a window with nothing counted says nothing rather than 0%', () => {
    const html = render(BOOK, '10000', {
      forecast: {
        ...wire(BOOK, '10000'),
        observedBurn: observedBurn({
          provenance: { user: '0', automated: '0', unattributed: '0' },
        }),
      },
    });

    expect(html).not.toInclude('Who classified the money');
    // Control: the rest of the basis is still rendered, so the absence above is
    // this guard firing rather than the whole block failing to render.
    expect(html).toInclude('Mean of 6 complete months');
  });
});

/**
 * SC-661 — the confirm/override affordance.
 *
 * SC-673 and the provenance caption explain WHY the measured drain feels alien
 * to the person reading it; only this does something about it. An override is
 * the one number in the whole chain the user authored, which is exactly what
 * 76% of the current inputs by value are not.
 */
describe('SC-661 — answering the measured drain', () => {
  // An ISO STRING, matching the wire: `payments.ts` converts `timestamptz` at
  // the boundary because there is no superjson transformer on this router, so a
  // fixture holding a `Date` would be testing a shape the client never sees.
  const AT = '2026-08-20T00:00:00.000Z';
  const withAnswer = (answer: unknown) => ({
    forecast: { ...wire(BOOK, '10000'), observedBurn: observedBurn(), observedBurnAnswer: answer },
  });

  test('an account that has said nothing is ASKED, and offered both answers', () => {
    const html = render(BOOK, '10000', withAnswer({ kind: 'none' }));

    expect(html).toInclude('Is this what you spend?');
    expect(html).toInclude('Yes, that&#x27;s right');
    expect(html).toInclude('Use my own figure');
  });

  /**
   * THE ASSERTION THE WHOLE FEATURE IS. €10,000 liquid against a measured
   * €1,250 a month is 8 months; against his own €2,500 it is 4. A headline that
   * kept dividing by the measurement would have taken his correction and
   * displayed it as a caption while ignoring it — which is worse than not
   * offering the override, because it looks like it worked.
   */
  test('an override REPLACES the runway denominator, not just the caption', () => {
    const measured = render(BOOK, '10000', withAnswer({ kind: 'none' }));
    expect(measured).toInclude('About 8 months at recent spending');

    const overridden = render(
      BOOK,
      '10000',
      withAnswer({ kind: 'override', amount: '2500', at: AT })
    );
    expect(overridden).toInclude('About 4 months at recent spending');
    expect(overridden).not.toInclude('About 8 months at recent spending');
  });

  /**
   * Both figures are named. An override that hid what it replaced would leave
   * him unable to see the disagreement he is expressing — and the measured
   * figure is the evidence for the provenance caption directly above it.
   */
  test('an override names his figure AND the measurement it replaced', () => {
    const html = render(BOOK, '10000', withAnswer({ kind: 'override', amount: '2500', at: AT }));

    expect(html).toInclude('Using your figure of');
    expect(html).toInclude('€2,500.00');
    expect(html).toInclude('€1,250.00');
    expect(html).toInclude('Go back to the measured figure');
    // It is not still asking a question he has answered.
    expect(html).not.toInclude('Is this what you spend?');
  });

  test('a confirmation that still holds says so, and stops asking', () => {
    const html = render(
      BOOK,
      '10000',
      withAnswer({ kind: 'confirmed', value: '1250', at: AT, matches: true })
    );

    expect(html).toInclude('You confirmed this on');
    expect(html).not.toInclude('Is this what you spend?');
    // A confirmation AGREES with the measurement rather than replacing it, so
    // the runway is unchanged.
    expect(html).toInclude('About 8 months at recent spending');
  });

  /**
   * THE STATE `users.observed_burn_confirmed_value` EXISTS FOR.
   *
   * Read against a bare timestamp this row still says he agreed. Read against
   * the value he agreed WITH, it says he agreed to something else — so the
   * surface stops claiming agreement, names both numbers, and asks again.
   */
  test('a confirmation the measurement has left names both figures and asks again', () => {
    const html = render(
      BOOK,
      '10000',
      withAnswer({ kind: 'confirmed', value: '800', at: AT, matches: false })
    );

    expect(html).toInclude('You confirmed');
    expect(html).toInclude('€800.00');
    expect(html).toInclude('€1,250.00');
    expect(html).toInclude('Yes, that&#x27;s right');
    expect(html).not.toInclude('You confirmed this on');
  });

  /**
   * The answer stores its own currency so a base-currency change cannot
   * reinterpret 6,300 EUR as 6,300 USD. Reporting `none` would DELETE his
   * answer from the screen with no event to notice it by; this says what
   * happened and asks again.
   */
  test('an answer in a currency the account has left says so rather than vanishing', () => {
    const html = render(BOOK, '10000', withAnswer({ kind: 'currencyChanged', at: AT }));

    expect(html).toInclude('was given in a different currency');
    expect(html).toInclude('Yes, that&#x27;s right');
    // Not silently treated as an override: the runway is the measured one.
    expect(html).toInclude('About 8 months at recent spending');
  });

  /**
   * ORDER IS THE ARGUMENT. His complaint was that he does not recognise the
   * figure; everything above the ask is why. Asking first would be asking him
   * to judge a number before being told what it is made of, which is how it
   * came to read as alien in the first place.
   */
  test('the ask comes AFTER the basis, the provenance and the exclusions', () => {
    const html = render(BOOK, '10000', withAnswer({ kind: 'none' }));
    const provenance = html.indexOf('Who classified the money');
    const excluded = html.indexOf('outflows are not counted');
    const ask = html.indexOf('Is this what you spend?');

    expect(provenance).toBeGreaterThan(-1);
    expect(excluded).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(excluded);
    expect(excluded).toBeGreaterThan(provenance);
  });
});

/**
 * SC-661 — the bundle can be newer than the api it is talking to.
 *
 * `observedBurnAnswer` is non-optional on the wire, and the fixture above
 * defaults it for exactly that reason. But the frontend and the api are
 * SEPARATE DEPLOY TARGETS (Cloudflare Pages and Fly), and on 2026-08-26 a
 * frontend change reached production on a day the Fly chain had not run once.
 * So a browser holding this bundle can be served a forecast payload with no
 * answer in it.
 *
 * Before the guard that is `answer.kind` on `undefined`, thrown in render, on
 * the page whose whole job is answering how long the money lasts.
 */
describe('SC-661 — a forecast payload from an older api', () => {
  const withoutAnswer = () => {
    const { observedBurnAnswer: _dropped, ...rest } = wire(BOOK, '10000');
    return { forecast: { ...rest, observedBurn: observedBurn() } };
  };

  test('renders the runway and simply omits the affordance', () => {
    const html = render(BOOK, '10000', withoutAnswer());

    // The answer this page exists to give is unaffected: an absent field means
    // no override, and the runway never depended on anything else.
    expect(html).toInclude('About 8 months at recent spending');
    // Everything the measurement carries with it still renders, so the absence
    // below is this guard firing rather than the block failing to mount.
    expect(html).toInclude('Who classified the money');
    expect(html).toInclude('Mean of 6 complete months');

    expect(html).not.toInclude('Is this what you spend?');
    expect(html).not.toInclude("Yes, that's right");
  });
});
