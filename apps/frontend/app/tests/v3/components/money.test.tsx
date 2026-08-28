import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { formatDate, resetFormatLocale, setFormatLocale } from '@scani/shared';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { renderDesktop } from '../../../../../../packages/frontend/ui/tests/helpers/render-desktop';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { rankCurrencyMatches, tokenLabel } from '../../../src/v3/components/money/CurrencyField';
import { DuplicateVendorPicker } from '../../../src/v3/components/money/DuplicateVendorPicker';
import {
  PAUSE_CONSEQUENCE_KEY,
  resumeConsequence,
} from '../../../src/v3/components/money/PaymentStatusToggle';
import { RecurringList } from '../../../src/v3/components/money/RecurringList';
import { RecurringSummary } from '../../../src/v3/components/money/RecurringSummary';
import { UpcomingFeed, upcomingPeekSpec } from '../../../src/v3/components/money/UpcomingFeed';
import { VendorList } from '../../../src/v3/components/money/VendorList';
import type { HistoryEstimate } from '../../../src/v3/lib/paymentTotals';

/**
 * `renderToStaticMarkup` has no `window`, so `useIsDesktop()` resolves false —
 * the phone surface, which is the one v3 is designed against. The desktop table
 * these surfaces feed is covered by `DataViewTable.test.tsx`.
 *
 * `StaticRouter` is required rather than incidental: every one of these reads
 * the location, because a row opens its record at a URL of its own (V3-11).
 *
 * None of the three components below touches a tRPC hook. That is a design
 * constraint, not a coincidence — the mutations live in leaf components
 * (`SettleActions`, `PaymentStatusToggle`, `VendorCreateRow`) precisely so the
 * surfaces stay renderable, and therefore assertable, without a client.
 */

const T = i18n.t.bind(i18n);

const TODAY = new Date().toISOString().slice(0, 10);

function daysFromToday(days: number): string {
  const base = Date.parse(`${TODAY}T00:00:00Z`);
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const VENDOR_NAMES = new Map([
  ['vendor-hetzner', 'Hetzner'],
  ['vendor-flare', 'Flare'],
]);
const TOKEN_SYMBOLS = new Map([
  ['token-eur', 'EUR'],
  ['token-gbp', 'GBP'],
]);

/**
 * The conversion the page hands down. Kept a plain object rather than a mock of
 * `useBaseCurrencyRates` precisely because these surfaces take it as a prop —
 * that is what lets a cross-currency total be asserted without a tRPC client.
 */
const RATES: BaseCurrencyRates = {
  baseCurrencyTokenId: 'token-eur',
  baseSymbol: 'EUR',
  rateByCurrencyTokenId: new Map([['token-gbp', { rate: '1.15', asOf: new Date().toISOString() }]]),
  ratesStatus: 'ready',
};

/** The same rates with GBP unresolvable — the case a total must not paper over. */
const RATES_WITHOUT_GBP: BaseCurrencyRates = {
  ...RATES,
  rateByCurrencyTokenId: new Map([['token-gbp', null]]),
};

const PAYMENT = {
  id: 'payment-hetzner',
  userId: 'user-1',
  vendorId: 'vendor-hetzner',
  direction: 'outflow',
  kind: 'fixed',
  expectedAmount: '42.00',
  currencyTokenId: 'token-eur',
  intervalUnit: 'month',
  intervalCount: 1,
  anchorDate: '2026-01-15',
  status: 'active',
  pausedAt: null,
  endDate: null,
  accountId: null,
  origin: 'manual',
  notes: null,
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

const SALARY = {
  ...PAYMENT,
  id: 'payment-flare',
  vendorId: 'vendor-flare',
  direction: 'inflow',
  expectedAmount: '2400.00',
  currencyTokenId: 'token-gbp',
  intervalUnit: 'week',
  intervalCount: 2,
};

/** A bill already past due — the set SC-77 pulled back out of the 30-day
 *  figure. Referenced by name rather than by index because the two bills and
 *  the salary each stand for a different rule. */
const LATE_BILL = {
  id: 'occurrence-late',
  paymentId: PAYMENT.id,
  dueDate: daysFromToday(-4),
  expectedAmount: '42.00',
  actualAmount: null,
  status: 'scheduled',
  matchedTransactionId: null,
  matchedExtractionId: null,
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
  payment: PAYMENT,
};

/** A bill genuinely inside the window the headline names. */
const DUE_BILL = {
  ...LATE_BILL,
  id: 'occurrence-due',
  dueDate: daysFromToday(10),
  expectedAmount: '99.00',
};

const SALARY_OCCURRENCE = {
  ...LATE_BILL,
  id: 'occurrence-soon',
  paymentId: SALARY.id,
  dueDate: daysFromToday(3),
  expectedAmount: '2400.00',
  payment: SALARY,
};

const OCCURRENCES = [LATE_BILL, DUE_BILL, SALARY_OCCURRENCE];

// The wire types carry a dozen fields these surfaces never read; the fixtures
// above are the real rows minus nothing, but TypeScript still wants the exact
// router output. Casting once here beats restating `RouterOutputs` by hand.
// biome-ignore lint/suspicious/noExplicitAny: test fixtures standing in for tRPC output.
const asAny = (value: unknown) => value as any;

/** A bare `ReactNode` — a peek's figure or its delta — as markup. `Fragment` via
 *  `createElement` rather than `<>…</>`, which lints as a useless fragment even
 *  though `renderToStaticMarkup` will not take a node without one. */
function renderNode(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

/**
 * No history estimate unless a case says otherwise (SC-625). Passed explicitly
 * rather than defaulted inside the components, so a test is always about a
 * book whose estimates somebody chose.
 */
const NO_HISTORY = new Map<string, HistoryEstimate>();

function renderFeed(path = '/payments', overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <UpcomingFeed
        occurrences={asAny(OCCURRENCES)}
        paymentCount={2}
        vendorNameById={VENDOR_NAMES}
        tokenSymbolById={TOKEN_SYMBOLS}
        rates={RATES}
        query={SETTLED_QUERY_STATE}
        historyEstimates={NO_HISTORY}
        {...overrides}
      />
    </StaticRouter>
  );
}

describe('UpcomingFeed', () => {
  // Fed in date-descending, so passing this means the feed reordered rather
  // than that the fixture happened to be in the right order already.
  test('leads with what is already late, whatever order the rows arrive in', () => {
    const html = renderFeed('/payments', { occurrences: asAny([...OCCURRENCES].reverse()) });
    expect(html).toInclude('Overdue');
    expect(html.indexOf('Overdue')).toBeLessThan(html.indexOf('Hetzner'));
    expect(html.indexOf('Hetzner')).toBeLessThan(html.indexOf('Flare'));
  });

  // The overdue group spans many dates, so its rows have to carry one; a date
  // group's heading already said it.
  test('an overdue row says how late it is', () => {
    expect(renderFeed()).toInclude('4 days overdue');
  });

  test('the committed figure is the outflow only — a salary is not a bill', () => {
    const html = renderFeed();
    expect(html).toInclude('Bills committed, next 30 days');
    expect(html).toInclude('€99.00');
    // Nothing was converted into *that* figure, so it makes no claim about
    // rates — the income block below it converts, and says so on its own line.
    expect(html.slice(0, html.indexOf('Income expected'))).not.toInclude('Converted from');
  });

  /**
   * SC-77 1. The headline read "Bills committed, next 30 days: €5,314.53" over
   * a feed whose own OVERDUE section held €4,169.79 of it — `withinDays` keeps
   * overdue rows (correctly, for the list) and the total summed what it was
   * handed. Two figures now, each naming its own set, neither absorbing the
   * other.
   */
  test('overdue money is its own figure, not part of the forward one', () => {
    const html = renderFeed();
    const committed = html.indexOf('Bills committed, next 30 days');
    const overdue = html.indexOf('Overdue, 1 bill');

    expect(overdue).toBeGreaterThan(committed);
    expect(html).toInclude('€99.00'); // due in 10 days
    expect(html).toInclude('€42.00'); // 4 days late
    // The sum of the two is nowhere on the screen: it is the number that was
    // wrong, and no label on this surface would be true of it.
    expect(html).not.toInclude('€141.00');
  });

  test('with nothing ahead, the forward figure says so instead of borrowing the arrears', () => {
    const html = renderFeed('/payments', { occurrences: asAny([LATE_BILL]) });
    expect(html).toInclude('Bills committed, next 30 days');
    expect(html).toInclude('€0.00');
    expect(html).toInclude('Overdue, 1 bill');
    expect(html).toInclude('Nothing due in the next 30 days');
  });

  test('nothing overdue means no overdue figure at all', () => {
    const html = renderFeed('/payments', { occurrences: asAny([DUE_BILL]) });
    expect(html).toInclude('€99.00');
    expect(html).not.toInclude('Overdue');
  });

  /**
   * V3-47, the reported defect: the figure had always been outflow-only and the
   * list under it had not, so a salary appeared as a row beneath a heading that
   * described bills. Income now has its own block, its own horizon and its own
   * figure — below the bills, never inside them.
   */
  test('income is a block of its own, under the bills rather than among them', () => {
    const html = renderFeed();
    expect(html).toInclude('Income expected, next 90 days');
    expect(html.indexOf('Bills committed')).toBeLessThan(html.indexOf('Income expected'));
    // Every row in the bill feed is a bill, so nothing there says which is which
    // any more — and the salary is not one of those rows.
    expect(html.indexOf('Flare')).toBeGreaterThan(html.indexOf('Income expected'));
  });

  /**
   * V3-47 meeting V3-52: the income figure is one base-currency number for the
   * same reason the bills figure is. £2,400 of salary against a EUR base is
   * €2,760.00 (2400 × 1.15) at the top of the block, while the row underneath
   * keeps the pounds that will actually arrive.
   */
  test('income is one converted figure, not a per-currency list', () => {
    const html = renderFeed();
    expect(html).toInclude('+€2,760.00');
    expect(html).toInclude('converted at today’s rates');
    expect(html).not.toInclude('Plus');
    expect(html).toInclude('£2,400.00');
  });

  test('income carries the sign and the gain token, not a colour of its own', () => {
    const html = renderFeed();
    expect(html).toInclude('text-gain');
    expect(html).toInclude('+€2,760.00');
  });

  test('the two figures are never netted, and each names its own window', () => {
    const html = renderFeed();
    expect(html).toInclude('Not counted against the 30-day bill figure above');
  });

  /** The other half of the honesty rule, on the income side: a payer's currency
   *  we hold no rate for is named beside the forecast, never dropped from it. */
  test('income we cannot convert is named beside the figure, not omitted', () => {
    const html = renderFeed('/payments', { rates: RATES_WITHOUT_GBP });
    expect(html).toInclude('Not included');
    expect(html).toInclude('no recent rate for GBP');
  });

  /** Income runs ninety days because "plan the income" is a forward question;
   *  a client invoice six weeks out is invisible in a thirty-day window. */
  test('income past the bill window is still expected income', () => {
    const html = renderFeed('/payments', {
      occurrences: asAny([{ ...SALARY_OCCURRENCE, dueDate: daysFromToday(45) }]),
    });
    expect(html).toInclude('+€2,760.00');
    expect(html).toInclude('Nothing due in the next 30 days');
  });

  test('a bill past the bill window is not in the bill figure', () => {
    const html = renderFeed('/payments', {
      occurrences: asAny([{ ...LATE_BILL, dueDate: daysFromToday(45) }]),
    });
    expect(html).not.toInclude('€42.00');
    expect(html).toInclude('Nothing due in the next 30 days');
  });

  // V3-52. The £2,400 bill used to print as a "Plus £2,400.00" tail beside a
  // €99.00 headline: two answers to one question. It is now one figure.
  test('a second currency is converted into the total, not listed beside it', () => {
    const html = renderFeed('/payments', {
      occurrences: asAny([
        DUE_BILL,
        { ...SALARY_OCCURRENCE, payment: { ...SALARY, direction: 'outflow' } },
      ]),
    });
    // 99 + (2400 × 1.15)
    expect(html).toInclude('€2,859.00');
    // SC-69 3.2: the caption names the PART that went through a rate, with its
    // own figure. "Converted from GBP" under €2,859.00 — of which €99.00 was
    // always euros — reads as a claim about the whole number.
    expect(html).toInclude('Includes');
    expect(html).toInclude('converted at today’s rates');
    expect(html).not.toInclude('Converted from');
    expect(html).not.toInclude('Plus');
    // The row itself keeps its own currency, with the equivalent underneath.
    expect(html).toInclude('£2,400.00');
    expect(html).toInclude('€2,760.00');
  });

  // The failure mode worth more than the feature: a bill we cannot price
  // quietly disappearing from what the reader is told they owe.
  test('a currency with no rate is named beside the total, never folded into it', () => {
    const html = renderFeed('/payments', {
      rates: RATES_WITHOUT_GBP,
      occurrences: asAny([
        DUE_BILL,
        { ...SALARY_OCCURRENCE, payment: { ...SALARY, direction: 'outflow' } },
      ]),
    });
    expect(html).toInclude('€99.00');
    expect(html).toInclude('Not included');
    expect(html).toInclude('no recent rate for GBP');
  });

  test('nothing due, but payments on file, is not the onboarding screen', () => {
    const html = renderFeed('/payments', { occurrences: [] });
    expect(html).toInclude('Nothing due in the next 90 days');
    expect(html).toInclude('See recurring payments');
    expect(html).not.toInclude('No recurring payments yet');
  });

  test('no payments at all gets the action that ends the empty state', () => {
    const html = renderFeed('/payments', { occurrences: [], paymentCount: 0 });
    expect(html).toInclude('No recurring payments yet');
    expect(html).toInclude('Add a payment');
  });

  // A peek is a sheet over the feed, not a screen instead of it — Radix
  // portals render nothing under SSR, so what this asserts is that the feed
  // itself is still standing behind a deep link.
  test('a deep-linked occurrence leaves the feed standing behind it', () => {
    const html = renderFeed('/payments/occurrence-late');
    expect(html).toInclude('Hetzner');
    expect(html).toInclude('Flare');
  });

  /** Since V3-16 the placeholder is on the §2.5 ramp: `renderToStaticMarkup`
   *  runs no effects, so this is the first frame of a loading feed — and the
   *  first frame of one draws nothing at all. */
  test('the first frame of a loading feed is empty, not a skeleton', () => {
    const html = renderFeed('/payments', {
      query: { ...SETTLED_QUERY_STATE, isLoading: true },
    });
    expect(html).not.toInclude('aria-busy');
    expect(html).not.toInclude('Hetzner');
  });

  test('a failed read says so rather than showing an empty feed', () => {
    const html = renderFeed('/payments', {
      occurrences: [],
      query: { ...SETTLED_QUERY_STATE, isError: true, error: { data: { httpStatus: 500 } } },
    });
    expect(html).toInclude('load upcoming payments');
    expect(html).toInclude('Try again');
    expect(html).not.toInclude('Nothing due in the next');
  });
});

/**
 * SC-798. The feed lists OCCURRENCES, so it was left out of SC-625 as a
 * separate design question — and answered it by rendering `— No value` on the
 * one surface that says what is due next, beside three surfaces quoting a
 * figure for the same payment.
 *
 * Every case below has an arm in the OPPOSITE direction, because "the estimate
 * appears" cannot tell a threaded map from a fixture that happened to carry an
 * amount: the same occurrence with no estimate must still read `No value`.
 */
describe('UpcomingFeed — a payment priced from history (SC-798)', () => {
  /** A variable bill with nothing declared. */
  const VARIABLE_PAYMENT = {
    ...PAYMENT,
    id: 'payment-power',
    kind: 'variable',
    expectedAmount: null,
  };

  /** …and an occurrence of it with nothing settled either: the row the ticket
   *  is about, inside the thirty-day window so the feed keeps it. */
  const VARIABLE_BILL = {
    ...DUE_BILL,
    id: 'occurrence-power',
    paymentId: VARIABLE_PAYMENT.id,
    expectedAmount: null,
    actualAmount: null,
    payment: VARIABLE_PAYMENT,
  };

  const POWER_ESTIMATE: ReadonlyMap<string, HistoryEstimate> = new Map([
    ['payment-power', { amount: '84.20', sourceDueDate: '2026-02-15' }],
  ]);

  test('the row shows the estimated figure AND cites the month it came from', () => {
    const html = renderFeed('/payments', {
      occurrences: asAny([VARIABLE_BILL]),
      historyEstimates: POWER_ESTIMATE,
    });

    expect(html).toInclude('84.20');
    // The mark and the citation travel together. A bare figure here would make
    // an estimated occurrence indistinguishable from a fixed bill in the same
    // feed, which is the one outcome worse than the dash it replaces.
    expect(html).toInclude('Estimated');
    expect(html).toInclude('Feb 2026');
    expect(html).not.toInclude('No value');
  });

  test('the control: the same row with no estimate still reads No value', () => {
    const html = renderFeed('/payments', {
      occurrences: asAny([VARIABLE_BILL]),
      historyEstimates: NO_HISTORY,
    });

    expect(html).toInclude('No value');
    expect(html).not.toInclude('84.20');
    expect(html).not.toInclude('Estimated');
    expect(html).not.toInclude('Feb 2026');
  });

  test('a settled occurrence keeps the amount that really moved', () => {
    // The estimate is a claim about the PAYMENT; a settlement is a measurement
    // of this occurrence, and it wins. Pinned because the obvious
    // simplification — `expectedAmount ?? estimate ?? actualAmount` — is
    // invisible to every other case here.
    const html = renderFeed('/payments', {
      occurrences: asAny([{ ...VARIABLE_BILL, actualAmount: '61.00' }]),
      historyEstimates: POWER_ESTIMATE,
    });

    expect(html).toInclude('61.00');
    expect(html).not.toInclude('84.20');
    expect(html).not.toInclude('Feb 2026');
  });

  test('a declared amount is never overwritten by an estimate keyed to it', () => {
    const html = renderFeed('/payments', {
      occurrences: asAny([DUE_BILL]),
      historyEstimates: new Map([
        ['payment-hetzner', { amount: '84.20', sourceDueDate: '2026-02-15' }],
      ]),
    });

    expect(html).toInclude('€99.00');
    expect(html).not.toInclude('84.20');
    expect(html).not.toInclude('Feb 2026');
  });

  /**
   * The headline over that row (SC-807).
   *
   * `occurrenceTotals` resolves an estimated occurrence to `'0'`, deliberately:
   * "Bills committed" and "what is due next" are different claims, and an
   * estimate is the reader saying we do not know this month's amount. What was
   * wrong is that the money was then accounted for NOWHERE above the rows —
   * `€0.00` sat directly over `€84.20 · ESTIMATED · from Feb 2026`, on one
   * screen, contradicting itself.
   *
   * Both arms, because an absent-only assertion cannot tell "fixed" from "the
   * component did not render": the found arm pins the new line, the absent arm
   * pins that the bare contradiction is gone.
   */
  describe('the committed headline above it', () => {
    test('names what it leaves out, with the amount and the count', () => {
      const html = renderFeed('/payments', {
        occurrences: asAny([VARIABLE_BILL]),
        historyEstimates: POWER_ESTIMATE,
      });

      // must-be-FOUND: the exclusion line renders, carries the figure, and
      // says why it is not in the headline.
      expect(html).toInclude('Not included');
      expect(html).toInclude('is estimated from its last settled amount');
      expect(html).toInclude('an estimate is not a commitment');

      // The contradiction, bounded to the block ABOVE the feed. The headline is
      // still €0.00 — that is the ruling, not the defect — but €0.00 is no
      // longer the only figure between the label and the first row, so the
      // €84.20 is accounted for above the feed as well as inside it.
      //
      // Sliced rather than asserted over the whole document: `€84.20` is in the
      // row too, so `toInclude` on `html` would pass over exactly the markup
      // this ticket is about.
      const block = html.slice(0, html.indexOf('Hetzner'));
      expect(block).toInclude('Bills committed, next 30 days');
      expect(block).toInclude('€0.00');
      expect(block).toInclude('€84.20');
      expect(block).toInclude('Not included');
    });

    test('the control: with no estimate there is no exclusion line at all', () => {
      // The asymmetry, pinned. A permanent second line reading €0.00 would
      // assert a category most books never have, so the line is conditional —
      // and a conditional that never renders is indistinguishable from one that
      // cannot, unless the case above proves it does.
      const html = renderFeed('/payments', {
        occurrences: asAny([VARIABLE_BILL]),
        historyEstimates: NO_HISTORY,
      });

      expect(html).toInclude('Bills committed, next 30 days');
      expect(html).not.toInclude('Not included');
      expect(html).not.toInclude('an estimate is not a commitment');
    });

    test('a declared bill is committed, and says nothing about estimates', () => {
      // The second control, and the one that would catch the line firing off
      // the wrong predicate: `DUE_BILL` declares €99.00, so it belongs IN the
      // figure and nowhere in the exclusion.
      const html = renderFeed('/payments', {
        occurrences: asAny([DUE_BILL]),
        historyEstimates: POWER_ESTIMATE,
      });

      expect(html).toInclude('€99.00');
      expect(html).not.toInclude('Not included');
    });

    /**
     * The tile 40px below, which has the identical defect and is fixed in the
     * same change (SC-807, scope widened by mgrin 2026-08-29).
     *
     * The unit is the SCREEN, not the function: one honest figure beside a
     * dishonest one is worse than neither, because the honest one implies the
     * surface was checked. `occurrenceTotals` is still untouched — the tile
     * gets the same `estimatedTotals` helper and a sentence of its own.
     */
    describe('and the overdue tile beside it', () => {
      /** The same variable bill, four days late and still unsettled. */
      const LATE_VARIABLE = {
        ...VARIABLE_BILL,
        id: 'occurrence-power-late',
        dueDate: daysFromToday(-4),
      };

      test('names what the overdue figure leaves out, in its own words', () => {
        const html = renderFeed('/payments', {
          occurrences: asAny([LATE_VARIABLE]),
          historyEstimates: POWER_ESTIMATE,
        });

        expect(html).toInclude('Overdue, 1 bill');
        expect(html).toInclude('1 overdue bill is estimated from its last settled amount');
        expect(html).toInclude('its real amount is still unknown');

        // Its OWN sentence. The committed figure's closing clause is a claim
        // about commitment and this tile makes no such claim — reusing it here
        // would be a true sentence under the wrong figure.
        expect(html).not.toInclude('an estimate is not a commitment');

        const block = html.slice(0, html.indexOf('Hetzner'));
        expect(block).toInclude('€0.00');
        expect(block).toInclude('€84.20');
      });

      test('the control: an overdue bill with a declared amount excludes nothing', () => {
        // `LATE_BILL` declares 42.00, so it belongs IN the overdue figure. This
        // is the case that catches the line firing off the wrong predicate.
        const html = renderFeed('/payments', {
          occurrences: asAny([LATE_BILL]),
          historyEstimates: POWER_ESTIMATE,
        });

        expect(html).toInclude('Overdue, 1 bill');
        expect(html).not.toInclude('Not included');
      });

      test('the two lines are separate claims about separate figures', () => {
        // Both estimated, one ahead and one late. Each tile names its own
        // exclusion and neither borrows the other's figure or sentence.
        const html = renderFeed('/payments', {
          occurrences: asAny([
            VARIABLE_BILL,
            {
              ...LATE_VARIABLE,
              paymentId: 'payment-water',
              payment: { ...VARIABLE_PAYMENT, id: 'payment-water' },
            },
          ]),
          historyEstimates: new Map([
            ...POWER_ESTIMATE,
            ['payment-water', { amount: '12.00', sourceDueDate: '2026-01-20' }],
          ]),
        });

        expect(html).toInclude('an estimate is not a commitment');
        expect(html).toInclude('its real amount is still unknown');
        // The committed line carries 84.20 and the overdue line 12.00 — never
        // the sum, and never each other's figure.
        expect(html).not.toInclude('€96.20');
        expect(html).toInclude('€12.00');
      });
    });

    test('the count pluralises over the bills it actually excludes', () => {
      const second = {
        ...VARIABLE_BILL,
        id: 'occurrence-water',
        paymentId: 'payment-water',
        payment: { ...VARIABLE_PAYMENT, id: 'payment-water' },
      };
      const html = renderFeed('/payments', {
        occurrences: asAny([VARIABLE_BILL, second]),
        historyEstimates: new Map([
          ...POWER_ESTIMATE,
          ['payment-water', { amount: '15.80', sourceDueDate: '2026-02-20' }],
        ]),
      });

      // The sum, not either row's figure — 84.20 + 15.80.
      expect(html).toInclude('€100.00');
      expect(html).toInclude('2 bills are estimated');
      expect(html).not.toInclude('1 bill is estimated');
    });
  });

  /**
   * The peek is the second render site, and it is the one SC-797 is about: the
   * sheet mounts through a Radix portal, so `renderToStaticMarkup` renders none
   * of it and every assertion above passes over a peek that still says `No
   * value`. `upcomingPeekSpec` is exported so the claim can be checked against
   * the spec as data — the same move `holdingPeekSpec` makes, for the same
   * reason.
   */
  describe('the peek behind the row', () => {
    const peekSpec = (historyEstimates: ReadonlyMap<string, HistoryEstimate>) =>
      upcomingPeekSpec({
        t: i18n.t.bind(i18n),
        occurrence: asAny(VARIABLE_BILL),
        vendorNameById: VENDOR_NAMES,
        tokenSymbolById: TOKEN_SYMBOLS,
        historyEstimates,
        today: TODAY,
        onSettled: () => undefined,
      });

    test('carries the same figure and the same mark as the row', () => {
      const spec = peekSpec(POWER_ESTIMATE);

      expect(renderNode(spec.value)).toInclude('84.20');
      // `delta` shares the figure's line, so the caveat cannot scroll away from
      // what it qualifies.
      const delta = renderNode(spec.delta);
      expect(delta).toInclude('Estimated');
      expect(delta).toInclude('Feb 2026');
    });

    test('the control: with no estimate the sheet has no figure and no mark', () => {
      const spec = peekSpec(NO_HISTORY);

      expect(renderNode(spec.value)).toInclude('No value');
      expect(spec.delta).toBeUndefined();
    });
  });
});

/**
 * Render the DESKTOP surface — the table — instead of the phone card list.
 *
 * EVERY OTHER TEST IN THIS FILE RENDERS WITH NO `window` AND THEREFORE ONLY
 * EVER SEES THE CARD LIST. That is not a gap in the abstract: SC-625 shipped
 * an `amount` column that rendered a bare dash for an estimated payment, and
 * the suite was green over it, because `expect(html).toInclude('84.20')` was
 * satisfied by the card beside it. A column render is invisible here unless
 * something forces this branch.
 *
 * The helper is shared with `@scani/ui`'s own tests (SC-797). It stubs and
 * restores `window.matchMedia` around one synchronous render, and refuses a
 * render that never read the stub — but a refusal is a claim about the HOOK,
 * not about the branch, so every test below still asserts `<table`.
 */
function renderRecurringDesktop(overrides: Record<string, unknown> = {}) {
  return renderDesktop(
    <StaticRouter location="/payments/recurring">
      <RecurringList
        payments={asAny([PAYMENT, SALARY])}
        vendorNameById={VENDOR_NAMES}
        tokenSymbolById={TOKEN_SYMBOLS}
        rates={RATES}
        query={SETTLED_QUERY_STATE}
        historyEstimates={NO_HISTORY}
        {...overrides}
      />
    </StaticRouter>
  );
}

function renderRecurring(path = '/payments/recurring', overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <RecurringList
        payments={asAny([PAYMENT, SALARY])}
        vendorNameById={VENDOR_NAMES}
        tokenSymbolById={TOKEN_SYMBOLS}
        rates={RATES}
        query={SETTLED_QUERY_STATE}
        historyEstimates={NO_HISTORY}
        {...overrides}
      />
    </StaticRouter>
  );
}

describe('RecurringList', () => {
  test('is the list surface, with its search and its refine control', () => {
    const html = renderRecurring();
    expect(html).toInclude('Search by vendor');
    expect(html).toInclude('aria-label="Filter, sort and group"');
    expect(html).toInclude('2 payments');
  });

  test('a row carries cadence and direction, not five columns', () => {
    const html = renderRecurring();
    expect(html).toInclude('Every month · Bill');
    expect(html).toInclude('Every 2 weeks · Income');
    expect(html).not.toInclude('<table');
  });

  /**
   * The commitment figure annualises before dividing to a month. A fortnightly
   * £2,400 is 26 payments a year, not 24 — but it is income and must not appear
   * here at all, so the only outflow (€42 monthly) is the whole figure.
   */
  test('committed-each-month counts active outflows only', () => {
    expect(renderRecurring()).toInclude('Committed each month');
    expect(renderRecurring()).toInclude('€42.00');
  });

  test('a paused payment is not a commitment', () => {
    const html = renderRecurring('/payments/recurring', {
      payments: asAny([{ ...PAYMENT, status: 'paused' }]),
    });
    // Nothing active is left, so the headline is zero — denominated in the
    // user's own currency, not in a hardcoded dollar. The row below still
    // shows the payment's own €42.00; the headline comes first in the markup.
    expect(html).toInclude('€0.00');
    expect(html.indexOf('€0.00')).toBeLessThan(html.indexOf('€42.00'));
    expect(html).not.toInclude('$');
    expect(html).toInclude('paused');
  });

  test('an empty surface offers the button that creates the first record', () => {
    const html = renderRecurring('/payments/recurring', { payments: [] });
    expect(html).toInclude('No recurring payments yet');
    expect(html).toInclude('/payments/recurring/new');
  });
});

/**
 * The toggle itself holds a tRPC mutation, so it is not renderable here — but
 * the sentence it shows before committing is the substance of V3-41, not
 * decoration. `payments.pause` shipped without an inverse, and what resume does
 * to a schedule (keeps the anchor; settles the pause window as skipped; lands
 * nothing overdue) is only a fair offer if the surface says so first.
 */
describe('PaymentStatusToggle copy', () => {
  test('resuming promises the original dates, and names where the skipped window starts', () => {
    const copy = resumeConsequence(i18n.t.bind(i18n), '2026-07-28T09:12:00.000Z');
    expect(copy).toInclude('original schedule');
    expect(copy).toInclude(formatDate('2026-07-28'));
    expect(copy).toInclude('skipped, not overdue');
    // The reading resume must never invite: a schedule restarted from today.
    expect(copy).not.toInclude('restart');
  });

  test('a payment paused before Scani recorded pause dates gets the narrower promise', () => {
    const copy = resumeConsequence(i18n.t.bind(i18n), null);
    expect(copy).toInclude('original schedule');
    expect(copy).toInclude('left exactly as they are');
    // No window exists for these rows, so promising one would be a lie.
    expect(copy).not.toInclude('skipped');
  });

  test('pausing says what becomes of the dates that pass meanwhile', () => {
    expect(i18n.t(PAUSE_CONSEQUENCE_KEY)).toInclude('skipped, not overdue');
  });
});

function renderCommitment(
  payments: unknown[],
  historyEstimates: ReadonlyMap<string, HistoryEstimate> = NO_HISTORY
) {
  return renderToStaticMarkup(
    <RecurringSummary
      payments={asAny(payments)}
      tokenSymbolById={TOKEN_SYMBOLS}
      rates={RATES}
      historyEstimates={historyEstimates}
    />
  );
}

/**
 * The hero the list hands to `V3DataViewConfig.summary`, which receives the
 * *filtered* rows. Its whole contract is that it adds up what it is given —
 * so narrowing the set has to move the figure (V3-32).
 */
describe('RecurringSummary', () => {
  test('adds up the set it is handed, not the whole book', () => {
    const second = { ...PAYMENT, id: 'payment-second', expectedAmount: '58.00' };
    expect(renderCommitment([PAYMENT, second])).toInclude('€100.00');
    expect(renderCommitment([PAYMENT])).toInclude('€42.00');
  });

  test('a set with nothing running in it reads zero, in the user’s own currency', () => {
    const html = renderCommitment([{ ...PAYMENT, status: 'paused' }]);
    expect(html).toInclude('€0.00');
    expect(html).not.toInclude('$');
  });

  // V3-52: unlike currencies are added *through a rate*, and the figure says so.
  test('commitments in several currencies make one figure, and admit to it', () => {
    const gbpBill = { ...SALARY, direction: 'outflow', intervalUnit: 'month', intervalCount: 1 };
    const html = renderCommitment([PAYMENT, gbpBill]);
    // 42 + (2400 × 1.15)
    expect(html).toInclude('€2,802.00');
    // The £2,400 is named as the converted part, not the whole (SC-69 3.2).
    expect(html).toInclude('£2,400.00');
    expect(html).toInclude('converted at today’s rates');
  });

  /**
   * SC-625 on the surface the ticket names. "Committed each month" has skipped
   * variable payments with no estimate since it was written, and said nothing
   * about it — so the count below is not decoration attached to the new
   * option, it is the denominator this figure never had.
   */
  describe('the variable payments it leaves out, and the ones it now includes', () => {
    const VARIABLE = {
      ...PAYMENT,
      id: 'payment-power',
      kind: 'variable',
      expectedAmount: null,
    };

    test('an unestimated variable payment is counted out loud, not silently dropped', () => {
      const html = renderCommitment([PAYMENT, VARIABLE]);

      // The figure is still the fixed bill alone — nothing is invented.
      expect(html).toInclude('€42.00');
      expect(html).toInclude('1 variable payment has no estimate and is not counted');
      expect(html).not.toInclude('estimated from its last settled amount');
    });

    test('with a history estimate it is added, and the line says so', () => {
      const html = renderCommitment(
        [PAYMENT, VARIABLE],
        new Map([['payment-power', { amount: '58.00', sourceDueDate: '2026-02-15' }]])
      );

      // 42 + 58, the same total two declared bills would give — which is
      // exactly why the sentence beneath it has to distinguish them.
      expect(html).toInclude('€100.00');
      expect(html).toInclude('Includes 1 variable payment estimated from its last settled amount');
      expect(html).not.toInclude('has no estimate and is not counted');
    });

    test('BOTH lines at once, because they answer different questions', () => {
      const other = { ...VARIABLE, id: 'payment-water' };
      const html = renderCommitment(
        [PAYMENT, VARIABLE, other],
        new Map([['payment-power', { amount: '58.00', sourceDueDate: '2026-02-15' }]])
      );

      expect(html).toInclude('Includes 1 variable payment estimated from its last settled amount');
      expect(html).toInclude('1 variable payment has no estimate and is not counted');
    });

    test('a history estimate for a payment that is not in this set changes nothing', () => {
      // The must-be-ABSENT control. The summary sees the FILTERED rows, so an
      // estimate keyed on a payment the reader has filtered away must not
      // reach the figure or the sentence — otherwise narrowing to one vendor
      // would report estimates belonging to another.
      const html = renderCommitment(
        [PAYMENT],
        new Map([['payment-power', { amount: '58.00', sourceDueDate: '2026-02-15' }]])
      );

      expect(html).toInclude('€42.00');
      expect(html).not.toInclude('estimated from its last settled amount');
    });
  });
});

describe('RecurringList — an estimated row does not look like a fixed bill (SC-625)', () => {
  const VARIABLE = {
    ...PAYMENT,
    id: 'payment-power',
    kind: 'variable',
    expectedAmount: null,
  };

  test('the row shows the estimated figure AND cites the month it came from', () => {
    const html = renderRecurring('/payments/recurring', {
      payments: asAny([VARIABLE]),
      historyEstimates: new Map([
        ['payment-power', { amount: '84.20', sourceDueDate: '2026-02-15' }],
      ]),
    });

    expect(html).toInclude('84.20');
    // The mark and the citation — the one thing a fixed bill in this same
    // column can never carry, because it has nothing to cite.
    expect(html).toInclude('Estimated');
    expect(html).toInclude('Feb 2026');
  });

  test('the control: the same row with no estimate carries neither', () => {
    const html = renderRecurring('/payments/recurring', {
      payments: asAny([VARIABLE]),
      historyEstimates: new Map(),
    });

    expect(html).not.toInclude('84.20');
    expect(html).not.toInclude('Feb 2026');
  });

  test('a FIXED payment is never marked, even if an estimate is somehow keyed to it', () => {
    // A declared amount always wins, so the mark must not appear beside a
    // figure somebody actually entered — that would be the surface calling a
    // declared bill a guess.
    const html = renderRecurring('/payments/recurring', {
      payments: asAny([PAYMENT]),
      historyEstimates: new Map([
        ['payment-hetzner', { amount: '999.00', sourceDueDate: '2026-02-15' }],
      ]),
    });

    expect(html).toInclude('42.00');
    expect(html).not.toInclude('999.00');
    expect(html).not.toInclude('Feb 2026');
  });

  test('the DESKTOP table carries the mark too, not just the phone card', () => {
    const html = renderRecurringDesktop({
      payments: asAny([VARIABLE]),
      historyEstimates: new Map([
        ['payment-power', { amount: '84.20', sourceDueDate: '2026-02-15' }],
      ]),
    });

    // MUST-BE-FOUND CONTROL, and it is the whole reason this test is worth
    // anything: if the `matchMedia` stub ever stops taking, this renders the
    // card list and every assertion below passes for the wrong surface —
    // which is precisely the failure the test exists to catch.
    expect(html).toInclude('<table');

    expect(html).toInclude('84.20');
    expect(html).toInclude('Estimated');
    expect(html).toInclude('Feb 2026');
  });

  test('the desktop control: no estimate, no figure and no mark in the table', () => {
    const html = renderRecurringDesktop({
      payments: asAny([VARIABLE]),
      historyEstimates: new Map(),
    });

    expect(html).toInclude('<table');
    expect(html).not.toInclude('84.20');
    expect(html).not.toInclude('Feb 2026');
  });
});

/** What `vendors.spend` returns: settled history, per currency and direction. */
const VENDOR_SPEND = {
  windowStart: '2025-08-13',
  windowMonths: 12,
  totals: [
    {
      vendorId: 'vendor-hetzner',
      currencyTokenId: 'token-eur',
      direction: 'outflow',
      allTime: '500.00',
      inWindow: '300.00',
      settledCount: 7,
      unpricedCount: 0,
    },
    {
      vendorId: 'vendor-hetzner',
      currencyTokenId: 'token-gbp',
      direction: 'outflow',
      allTime: '100.00',
      inWindow: '100.00',
      settledCount: 2,
      unpricedCount: 0,
    },
  ],
  recent: [
    {
      id: 'settled-1',
      vendorId: 'vendor-hetzner',
      paymentId: PAYMENT.id,
      dueDate: '2026-07-01',
      amount: '42.00',
      currencyTokenId: 'token-eur',
      direction: 'outflow',
    },
  ],
};

function renderVendors(path = '/vendors', overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <VendorList
        vendors={asAny([
          { id: 'vendor-hetzner', displayName: 'Hetzner', category: 'Hosting', website: null },
          { id: 'vendor-flare', displayName: 'Flare', category: null, website: null },
        ])}
        payments={asAny([PAYMENT, SALARY, { ...PAYMENT, id: 'payment-2' }])}
        spend={asAny(VENDOR_SPEND)}
        tokenSymbolById={TOKEN_SYMBOLS}
        rates={RATES}
        query={SETTLED_QUERY_STATE}
        historyEstimates={NO_HISTORY}
        creating={false}
        onCreatingChange={() => {}}
        {...overrides}
      />
    </StaticRouter>
  );
}

describe('VendorList', () => {
  test('a row is a name, a category and the count that makes it worth a row', () => {
    const html = renderVendors();
    expect(html).toInclude('Hetzner');
    expect(html).toInclude('Hosting');
    expect(html).toInclude('Uncategorised');
    expect(html).toInclude('2 vendors');
  });

  test('the count is announced, since “2” alone says nothing', () => {
    expect(renderVendors()).toInclude('Hetzner, 2 payments');
  });

  // V3-53. The row's figure is the monthly commitment: two €42/month payments
  // point at Hetzner, so it costs €84.00 a month whatever it has been paid.
  test('a row carries what the vendor costs per month', () => {
    expect(renderVendors()).toInclude('84.00');
  });

  // The two claims stay two figures — one about the future, one about the past.
  test('the summary separates what is committed from what has been paid', () => {
    const html = renderVendors();
    expect(html).toInclude('Committed each month');
    expect(html).toInclude('Paid, last 12 months');
  });

  /**
   * SC-78 §5, and the assertion this test used to make in reverse.
   *
   * Flare's only payment is income, so it commits nothing OUTGOING — and the
   * surface used to print that outgoing zero as the vendor's figure, under a
   * column headed "Committed per month". On a real device that rendered a
   * €5,850-a-month employer as `Employer · 1 payment — €0.00`, four times over
   * in its peek, beside the words "Payments 1". The zero was arithmetically
   * true and told the reader the opposite of the truth.
   *
   * A row now shows its OWN direction's figure, says which direction that is,
   * and carries `<Numeric delta>`'s sign so the two can never be read as one
   * column of bills.
   */
  test('an income vendor shows what it pays you, not a spend total of zero', () => {
    const html = renderVendors();
    expect(html).toInclude('>Flare</span><span class="block truncate text-caption');
    // £5,200/month through the 1.15 rate.
    expect(html).toInclude('+€5,980.00');
    expect(html).toInclude('Income');
    expect(html).not.toInclude('€0.00');
  });

  test('the income total is beside what is owed, never netted into it', () => {
    const html = renderVendors();
    expect(html).toInclude('Expected per month');
    expect(html).toInclude('Not subtracted from what you owe');
    // The bills figure is untouched by the salary sitting next to it.
    expect(html).toInclude('€84.00');
  });

  test('the money column stops claiming every row is a bill', () => {
    expect(renderVendors()).toInclude('Per month');
  });

  test('an income row announces its direction, so two rows are told apart', () => {
    expect(renderVendors()).toInclude('Flare, Income, 1 payment');
  });

  // GBP settlements with no rate must be named beside the total, not folded
  // in and not dropped — a vendor billed in an unconvertible currency cannot
  // be allowed to read as costing nothing.
  test('an un-convertible currency is named rather than silently omitted', () => {
    const html = renderVendors('/vendors', { rates: RATES_WITHOUT_GBP });
    expect(html).toInclude('no recent rate for GBP');
    expect(html).toInclude('£100.00');
  });

  test('the empty state says where vendors come from', () => {
    const html = renderVendors('/vendors', { vendors: [] });
    expect(html).toInclude('No vendors yet');
    expect(html).toInclude('New vendor');
  });
});

describe('CurrencyField ranking', () => {
  const tokens = [
    { id: 't-usdc', symbol: 'USDC', name: 'USD Coin', type: 'crypto', typeName: 'Cryptocurrency' },
    { id: 't-usd', symbol: 'USD', name: 'US Dollar', type: 'fiat', typeName: 'Fiat Currency' },
    { id: 't-eur', symbol: 'EUR', name: 'Euro', type: 'fiat', typeName: 'Fiat Currency' },
    { id: 't-btc', symbol: 'BTC', name: 'Bitcoin', type: 'crypto', typeName: 'Cryptocurrency' },
  ];

  // The whole reason the ranking exists: "USD" must not offer "USDC" first.
  test('an exact symbol match leads', () => {
    expect(rankCurrencyMatches(T, asAny(tokens), 'usd').map((c) => c.symbol)).toEqual([
      'USD',
      'USDC',
    ]);
  });

  test('fiat leads the rest, because a bill is usually in one', () => {
    expect(rankCurrencyMatches(T, asAny(tokens), 'o').map((c) => c.symbol)).toEqual([
      'EUR',
      'USD',
      'BTC',
      'USDC',
    ]);
  });

  test('an empty query offers the currencies, not every token in the database', () => {
    expect(rankCurrencyMatches(T, asAny(tokens), '').map((c) => c.symbol)).toEqual(['EUR', 'USD']);
  });

  test('the label is what a person recognises, not an id', () => {
    expect(tokenLabel(T, { symbol: 'EUR', name: 'Euro', type: 'fiat' })).toBe('EUR — Euro');
  });

  /**
   * SC-419. A fiat label is DERIVED from the symbol, so the stored English in
   * `tokens.name` never reaches the picker. The fixture's name is deliberately
   * wrong — if the map were bypassed, `EUR — Not A Real Name` would come back.
   */
  test('a fiat label ignores the stored name and derives from the symbol', () => {
    expect(tokenLabel(T, { symbol: 'EUR', name: 'Not A Real Name', type: 'fiat' })).toBe(
      'EUR — Euro'
    );
  });

  test('a Spanish reader gets the Spanish currency name, not the English one', () => {
    try {
      setFormatLocale('es');
      const label = tokenLabel(T, { symbol: 'USD', name: 'United States Dollar', type: 'fiat' });
      expect(label).toBe('USD — dólar estadounidense');
      expect(label).not.toContain('United States Dollar');
    } finally {
      resetFormatLocale();
    }
  });

  /** The must-be-ABSENT arm: a non-fiat name is a proper noun and is KEPT. */
  test('a non-fiat label keeps its stored name', () => {
    expect(tokenLabel(T, { symbol: 'BTC', name: 'Bitcoin', type: 'crypto' })).toBe('BTC — Bitcoin');
    expect(tokenLabel(T, { symbol: 'AAPL', name: 'APPLE INC', type: 'stock' })).toBe(
      'AAPL — APPLE INC'
    );
  });

  /** A token with no type code at all keeps its name rather than throwing. */
  test('no type code degrades to the stored name', () => {
    expect(tokenLabel(T, { symbol: 'XXX', name: 'Something' })).toBe('XXX — Something');
  });

  test('the picker searches what the row SHOWS, not the English underneath', () => {
    try {
      setFormatLocale('es');
      // `dólar` appears in no `name` in the fixture; it exists only in the
      // derived Spanish label. A search over the stored name finds nothing.
      expect(rankCurrencyMatches(T, asAny(tokens), 'dólar').map((c) => c.symbol)).toEqual(['USD']);
    } finally {
      resetFormatLocale();
    }
  });
});

/**
 * SC-78 §4. The picker this replaces was a `Select`: on a real iPhone its
 * option list opened UPWARD over the sheet's own header and out onto the dimmed
 * page — so while choosing which vendor to DELETE the reader could no longer
 * see which one it was being folded into — with rows measured at a 32pt pitch
 * across 21 adjacent vendors, under the 44pt floor.
 *
 * Both halves are asserted here because both are structural, and a rendered
 * string is where they are visible without a device.
 */
describe('DuplicateVendorPicker', () => {
  const CANDIDATES = Array.from({ length: 12 }, (_, index) => ({
    id: `vendor-${index}`,
    displayName: `Vendor ${index}`,
  }));

  const renderPicker = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <DuplicateVendorPicker
        survivorName="Acme Ltd"
        candidates={CANDIDATES}
        value=""
        onChange={() => {}}
        {...over}
      />
    );

  test('every row is a button, which is what the 44px coarse-pointer rule keys off', () => {
    const html = renderPicker();
    for (const candidate of CANDIDATES) {
      expect(html).toInclude(candidate.displayName);
    }
    // One button per candidate — a `div[role="option"]` is excluded from the
    // token layer's touch floor, and that exclusion is the 32pt defect.
    expect(html.split('<button').length - 1).toBe(CANDIDATES.length);
    expect(html).toInclude('py-3');
  });

  test('nothing floats, so the list cannot cover the surface that names the survivor', () => {
    const html = renderPicker();
    expect(html).not.toInclude('position:');
    expect(html).not.toInclude('absolute');
    expect(html).not.toInclude('fixed');
  });

  test('the vendor being merged INTO is named inside the scrolling list', () => {
    const html = renderPicker();
    expect(html).toInclude('Acme Ltd');
    expect(html).toInclude('sticky');
    expect(html).toInclude('which is kept');
  });

  test('a long list gets a search field; a short one does not raise a keyboard for nothing', () => {
    expect(renderPicker()).toInclude('Search for the duplicate vendor');
    expect(renderPicker({ candidates: CANDIDATES.slice(0, 3) })).not.toInclude(
      'Search for the duplicate vendor'
    );
  });

  test('the chosen row is announced as chosen, not merely shaded', () => {
    const html = renderPicker({ value: 'vendor-3' });
    expect(html).toInclude('aria-checked="true"');
  });
});
