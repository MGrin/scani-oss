import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { TRANSFER_REVIEW_KIND } from '@scani/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import type { AuthContextType } from '../../../src/contexts/AuthContext';
import { AuthContext } from '../../../src/contexts/auth-context';
import { BaseCurrencyProvider } from '../../../src/contexts/BaseCurrencyContext';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { trpc } from '../../../src/lib/trpc';
import { CoverageNote } from '../../../src/v3/components/home/CoverageNote';
import { DisclosureButton } from '../../../src/v3/components/home/DisclosureButton';
import {
  type FirstRunJob,
  FirstRunPanel,
  resolveFirstRunState,
} from '../../../src/v3/components/home/FirstRunPanel';
import { HeroBlock } from '../../../src/v3/components/home/HeroBlock';
import { HeroDetails } from '../../../src/v3/components/home/HeroDetails';
import { formatChartDate } from '../../../src/v3/components/home/PortfolioChart';
import { UpcomingFootLine } from '../../../src/v3/components/home/UpcomingBlock';
import { VaultProgressRow } from '../../../src/v3/components/home/VaultsBlock';
import type { HomeChart } from '../../../src/v3/hooks/useHomeChart';
import {
  type FigureQuality,
  HOME_METRIC_TITLE_KEYS,
  HOME_METRICS,
  heroFigureQuality,
  homePeriodByKey,
  type PnLPoint,
  type VaultRow,
} from '../../../src/v3/lib/home';
import {
  type EstimableOccurrence,
  estimatedTotals,
  occurrenceTotals,
} from '../../../src/v3/lib/money';
import type { HistoryEstimate } from '../../../src/v3/lib/paymentTotals';
import { pendingTransferCount } from '../../../src/v3/lib/review';

/**
 * The blocks themselves each own a tRPC query, so they cannot be rendered
 * without a client — and `<PortfolioChart>` is recharts, which under server
 * rendering produces an empty container regardless of its data (see the note in
 * `charts.test.tsx`). What is left worth asserting here is the two pieces that
 * are neither: the axis formatter and the disclosure control every list block
 * uses to stay bounded on a phone.
 */

describe('formatChartDate', () => {
  test.each([
    // Day-first, because the axis reads `APP_LOCALE` now instead of an
    // English-only month table — see `formatChartDate` (SC-201).
    ['2026-08-12', 'daily', '12 Aug'],
    ['2026-08-12', 'weekly', '12 Aug'],
    // Past a year of history a day-of-month tick is noise, so the axis names
    // the month and the year instead.
    ['2026-08-12', 'monthly', 'Aug 2026'],
  ])('%s at %s granularity reads as %s', (iso, granularity, expected) => {
    expect(formatChartDate(iso, granularity)).toBe(expected);
  });

  test('a date it cannot parse is passed through rather than rendered as NaN', () => {
    expect(formatChartDate('not-a-date', 'daily')).toBe('not-a-date');
  });
});

describe('DisclosureButton', () => {
  test('names what it reveals, and reports its state to assistive tech', () => {
    const html = renderToStaticMarkup(
      <DisclosureButton expanded={false} onToggle={() => {}} label="the 14 in Other" />
    );
    expect(html).toInclude('Show the 14 in Other');
    expect(html).toInclude('aria-expanded="false"');
  });

  test('open, it offers the way back', () => {
    const html = renderToStaticMarkup(
      <DisclosureButton expanded onToggle={() => {}} label="the 14 in Other" />
    );
    expect(html).toInclude('Show less');
    expect(html).toInclude('aria-expanded="true"');
  });
});

/**
 * The row `VaultsBlock` is a list of. Extracted so it can be rendered without a
 * tRPC client — the block itself owns the query — and because it is the one row
 * on the home screen that is not a `<DataRow>`: a vault's answer is a ratio, and
 * the three zones have nowhere to put a track.
 */
const VAULT: VaultRow = {
  id: 'v-1',
  name: 'Emergency fund',
  color: '#22c55e',
  currency: 'EUR',
  current: 6200,
  target: 10_000,
  progress: 62,
  fill: 62,
};

function renderVault(row: VaultRow) {
  return renderToStaticMarkup(
    <StaticRouter location="/">
      <ul>
        <VaultProgressRow row={row} />
      </ul>
    </StaticRouter>
  );
}

describe('VaultProgressRow', () => {
  // The reported defect (SC-74): the row was `<li> <div> <span>` and nothing on
  // the app's first screen could open a vault.
  test('the whole row is a link to the vault', () => {
    const html = renderVault(VAULT);
    expect(html).toInclude('href="/vaults/v-1"');
    expect(html).toInclude('Emergency fund');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test('it carries the hover, active and focus-visible states the rest of v3 uses', () => {
    const html = renderVault(VAULT);
    // `--surface-hover`, not `--surface-2`, which is white on the light page.
    expect(html).toInclude('hover:bg-surface-hover');
    expect(html).toInclude('active:bg-surface-hover');
    expect(html).not.toInclude('bg-surface-2');
    expect(html).toInclude('focus-visible:ring-2');
  });

  // 44px on touch comes from the token layer matching `a[href]` under
  // `pointer: coarse` (V3-23). `min-h-tap` here would land in `@layer
  // utilities`, beat that rule and impose the height on a mouse as well.
  test('no hardcoded height, so the pointer-coarse rule stays in charge', () => {
    expect(renderVault(VAULT)).not.toInclude('min-h-');
  });

  test('the track is still described for anyone who cannot see it', () => {
    expect(renderVault(VAULT)).toInclude('aria-label="Emergency fund: 62% of target"');
  });

  // An over-funded vault is genuinely at 130%; the track stops at full because
  // a bar overflowing its container reads as a rendering bug.
  test('an over-funded vault states the real figure and a full track', () => {
    const html = renderVault({ ...VAULT, progress: 130, fill: 100 });
    expect(html).toInclude('130%');
    expect(html).toInclude('width:100%');
  });

  test('a vault with no colour renders no swatch', () => {
    const html = renderVault({ ...VAULT, color: null });
    expect(html).not.toInclude('#22c55e');
  });
});

/**
 * SC-161 — the coverage figure, on the surface the reader actually opens.
 *
 * The block that owns it is a tRPC query, but the note is pure props, which is
 * the reason it is its own component: the copy is the deliverable here and it
 * should be checkable without a client or a browser.
 *
 * It does need a router now. SC-160's clause is a link — the only one of the
 * four the reader can act on — so the note is rendered inside a
 * `<StaticRouter>`. That is a real cost against the paragraph above it, and it
 * buys the thing that clause exists for: a pointer from the figure to the queue
 * that clears it.
 */
const FULL: FigureQuality = {
  priced: 30,
  priceable: 30,
  percent: 100,
  complete: true,
  unpriceable: 0,
  stalePriced: 0,
  basisUnknown: 0,
  transfersUnreviewed: 0,
};

const renderNote = (quality: FigureQuality) =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <CoverageNote quality={quality} />
    </StaticRouter>
  );

describe('CoverageNote', () => {
  test('the fraction is on the screen, not in an export', () => {
    const html = renderNote({ ...FULL, priced: 28, percent: 93, complete: false });
    expect(html).toInclude('93% priced');
    expect(html).toInclude('28 of 30 holdings');
  });

  test('it answers both halves at once — how much is real, and what was left out', () => {
    const html = renderNote({
      ...FULL,
      priced: 28,
      percent: 93,
      complete: false,
      unpriceable: 4,
      stalePriced: 2,
      basisUnknown: 3,
    });
    expect(html).toInclude('4 unpriceable');
    expect(html).toInclude('2 stale quotes');
    expect(html).toInclude('upper bound');
  });

  /**
   * SC-176 — what only markup can pin about the shape.
   *
   * The wording is a pure function and lives in `tests/v3/lib/home.test.ts`.
   * What lives here is the decision that each clause is its own unbreakable
   * span with the `·` OUTSIDE it. As one joined string the run broke wherever
   * the width ran out, which at 390px was mid-parenthetical — "(the gain is an
   * / upper bound)" over two lines, and a separator that separates nothing.
   */
  test('a clause cannot be broken across lines; only the separators can', () => {
    const html = renderNote({ ...FULL, stalePriced: 2, basisUnknown: 3 });
    expect(html).toInclude('<span class="whitespace-nowrap">2 stale quotes</span>');
    expect(html).toInclude(
      '<span class="whitespace-nowrap">3 no cost basis (gain is an upper bound)</span>'
    );
    // The separator is between the spans, not inside one — it is the only
    // place the browser is allowed to wrap.
    expect(html).toInclude('</span> · <span');
  });

  // "Unpriceable", never "unpriced": the first is honest, the second implies
  // we failed to fetch something that exists.
  test('never calls a token with no market unpriced', () => {
    const html = renderNote({ ...FULL, unpriceable: 4 });
    expect(html).not.toMatch(/unpriced\b/);
  });

  test('a clean account gets one quiet line and no list', () => {
    const html = renderNote(FULL);
    expect(html).toInclude('All 30 holdings priced');
    expect(html).toInclude('text-muted-foreground');
    expect(html).not.toInclude('·');
  });

  // No gain/loss ink one line under a `<DeltaPill>` that means money moved,
  // and v3 has no third tone that is not already spoken for.
  test('it is monochrome', () => {
    const html = renderNote({ ...FULL, priced: 4, percent: 13, complete: false });
    expect(html).not.toInclude('text-loss');
    expect(html).not.toInclude('text-gain');
  });

  /**
   * SC-160. The wording is pinned in `tests/v3/lib/home.test.ts`, where it is a
   * pure function; what only markup can pin is the decision this component
   * makes about it — the unreviewed-transfer clause is a LINK and the other
   * three are not.
   *
   * That asymmetry is the clause's entire reason for existing. The other three
   * name limits of what could be measured and nothing on this screen clears
   * them; this one is a queue the reader can empty. It is exactly the kind of
   * thing a later tidy-up folds back into the omissions run without noticing
   * what it cost.
   */
  test('the unreviewed-transfer clause is a link to the queue that clears it', () => {
    const html = renderNote({ ...FULL, transfersUnreviewed: 3 });
    expect(html).toInclude('href="/review/transfers"');
    expect(html).toInclude('Realized PnL excludes 3 unclassified payments out');
  });

  test('the whole sentence is the tap target, not a word inside it', () => {
    // At 390px a two-word target inside a caption is the one thing in this
    // block a thumb misses, and the sentence already names where it goes.
    const anchor = /<a [^>]*>([^<]*)<\/a>/.exec(renderNote({ ...FULL, transfersUnreviewed: 2 }));
    expect(anchor?.[1]).toBe('Realized PnL excludes 2 unclassified payments out');
  });

  test('the upward-biased omissions stay prose, with nothing to tap', () => {
    const html = renderNote({ ...FULL, unpriceable: 4, stalePriced: 2, basisUnknown: 3 });
    expect(html).toInclude('4 unpriceable');
    expect(html).not.toInclude('<a');
  });

  test('an empty queue renders no clause at all', () => {
    expect(renderNote({ ...FULL, basisUnknown: 1 })).not.toInclude('Realized PnL excludes');
  });
});

/**
 * SC-1070 — the caption moves when the queue does, without waiting for 04:00.
 *
 * The whole path a reader traverses, minus the two things a static render
 * cannot hold: the wire rows `review.listPending` produces, through
 * `pendingTransferCount` and `heroFigureQuality`, into the sentence
 * `<CoverageNote>` puts on the screen.
 *
 * **What went wrong is not visible from any one of those pieces.** The series
 * row is a `portfolio_value_daily` snapshot the rollup wrote at 04:00 and is
 * correct as a chart point; the caption's sentence is correct as English; the
 * queue is correct. Only the composition is wrong — the sentence promises the
 * queue holds exactly the rows it counted, and answering them left the count
 * where it was until the next night, under a link to a page with nothing on
 * it. So the assertion has to be made over the composition, and the series row
 * carries a DIFFERENT number from the queue in every case below on purpose:
 * if the two agreed, a caption reading the stale column would pass.
 */
const PNL_ROW_SAYING_FOUR: PnLPoint = {
  date: '2026-09-05',
  realizedPnl: '100',
  unrealizedPnl: '10',
  totalPnl: '110',
  holdingsWithKnownValue: 30,
  holdingsTotal: 30,
  holdingsUnpriceable: 0,
  holdingsStalePriced: 0,
  holdingsBasisUnknown: 0,
  // What the 04:00 rollup wrote. Never what the caption says.
  transfersUnreviewed: 4,
};

/** The shape `ReviewFeedService.fromTransfers` emits — one aggregate row for
 *  the whole queue, carrying its size in `represents`, and no row at all once
 *  the queue is empty. */
const transferQueueRow = (waiting: number) => ({
  kind: TRANSFER_REVIEW_KIND,
  represents: waiting,
});

const renderCaption = (feed: { kind: string; represents: number }[]) => {
  const quality = heroFigureQuality({
    isPnl: true,
    netWorthPoints: [],
    pnlPoints: [PNL_ROW_SAYING_FOUR],
    pendingTransfers: pendingTransferCount(feed),
  });
  expect(quality).not.toBeNull();
  return renderNote(quality as FigureQuality);
};

describe('the PnL caption against the live review queue', () => {
  test('answering every transfer clears the sentence in the same request cycle', () => {
    // The collector stops emitting a row once the queue empties, so this feed
    // is what the reader's next render sees the moment the answer lands —
    // no rollup in between. The series row still says four.
    expect(renderCaption([])).not.toInclude('Realized PnL excludes');
  });

  test('answering some of them moves the number rather than zeroing it', () => {
    // The control. Without it, the arm above passes for either of two
    // reasons — "the live count won" and "the count was hard-zeroed" are the
    // same observation at zero — and only one of them is the fix.
    const html = renderCaption([transferQueueRow(2)]);
    expect(html).toInclude('Realized PnL excludes 2 unclassified payments out');
    expect(html).not.toInclude('4 unconfirmed');
  });

  test('a queue that has gained rows since 04:00 is stated at its live size', () => {
    // The other direction, and the one that says this is not a fix pointed
    // downward: six waiting against a stored four must read six.
    expect(renderCaption([transferQueueRow(6)])).toInclude(
      'Realized PnL excludes 6 unclassified payments out'
    );
  });

  test('another queue\u2019s rows are not counted as transfers', () => {
    // `review.listPending` is a read-model over several producers and the
    // balance-gap collector aggregates the same way. Summing the feed instead
    // of finding the transfer row would put unexplained balance changes in a
    // sentence about transfers.
    expect(renderCaption([{ kind: 'balance-gap', represents: 9 }])).not.toInclude(
      'Realized PnL excludes'
    );
  });

  test('the net-worth metric ignores the queue entirely', () => {
    // SC-160's gate, restated against the live source: an unanswered
    // withdrawal says nothing about what the portfolio is worth.
    const quality = heroFigureQuality({
      isPnl: false,
      netWorthPoints: [PNL_ROW_SAYING_FOUR],
      pnlPoints: [],
      pendingTransfers: 6,
    });
    expect(quality?.transfersUnreviewed).toBe(0);
    expect(renderNote(quality as FigureQuality)).not.toInclude('Realized PnL excludes');
  });
});

/**
 * The first screen of an empty account (SC-451).
 *
 * `FirstRun` owns the query; `FirstRunPanel` is the half that can be rendered
 * without a tRPC client, which is the same split every other block on this
 * screen uses. #1069 shipped the invitation with no test of any kind, so these
 * cover both states rather than only the one this branch added.
 */
const job = (over: Partial<FirstRunJob>): FirstRunJob => ({
  jobId: 'j-1',
  jobName: 'file-import',
  state: 'queued',
  ...over,
});

describe('resolveFirstRunState', () => {
  test('no jobs at all is the invitation', () => {
    expect(resolveFirstRunState([])).toEqual({ kind: 'invite' });
  });

  test('a running capture is named, so the screen stops saying "nothing tracked yet"', () => {
    const state = resolveFirstRunState([job({ jobId: 'parse-7', state: 'active' })]);
    expect(state).toEqual({ kind: 'importing', jobId: 'parse-7' });
  });

  test.each(['queued', 'active', 'progress'] as const)('%s counts as in flight', (state) => {
    expect(resolveFirstRunState([job({ state })]).kind).toBe('importing');
  });

  test.each(['completed', 'failed'] as const)('%s does not', (state) => {
    // A completed parse that produced holdings takes the whole panel away, and
    // one that failed is the review feed's to report — neither is "running".
    expect(resolveFirstRunState([job({ state })]).kind).toBe('invite');
  });

  test('a job that is not a capture leaves the invitation standing', () => {
    // Re-pricing a holding the account does not have yet is not an attempt to
    // get data in, and reporting it as one would tell the reader to wait for
    // something that can never fill this screen.
    expect(resolveFirstRunState([job({ jobName: 'holding-price-update' })]).kind).toBe('invite');
  });

  test('the newest in-flight capture wins — the list arrives newest first', () => {
    const state = resolveFirstRunState([
      job({ jobId: 'newest', state: 'active' }),
      job({ jobId: 'older', state: 'queued' }),
    ]);
    expect(state).toEqual({ kind: 'importing', jobId: 'newest' });
  });
});

describe('FirstRunPanel', () => {
  const render = (state: Parameters<typeof FirstRunPanel>[0]['state']) =>
    renderToStaticMarkup(
      <StaticRouter location="/">
        <FirstRunPanel state={state} onOpenCapture={() => {}} />
      </StaticRouter>
    );

  test('leads with one route in, and it is a link rather than a chooser', () => {
    const html = render({ kind: 'invite' });
    expect(html).toInclude('href="/import"');
    expect(html).toInclude('Upload a screenshot or file');
    expect(html.indexOf('screenshot')).toBeLessThan(html.indexOf('CSV'));
    // And it says outright that no credential is wanted — the ask this route
    // exists to avoid.
    expect(html).toInclude('nothing to log into');
  });

  test('still admits the other routes exist, quietly', () => {
    expect(render({ kind: 'invite' })).toInclude('Or pick another way in');
  });

  test('a running import replaces the invitation rather than sitting beside it', () => {
    const html = render({ kind: 'importing', jobId: 'parse-7' });
    expect(html).toInclude('An import is running');
    expect(html).toInclude('href="/jobs/parse-7"');
    // "Nothing tracked yet" over a parse in flight reads as "you have not
    // tried" — the SC-153 defect, one state along.
    expect(html).not.toInclude('Nothing tracked yet');
    expect(html).not.toInclude('href="/import"');
    // The sheet stays offered: a running import does not cover the account the
    // reader was about to add.
    expect(html).toInclude('Or pick another way in');
  });
});

/**
 * SC-818. Both foot-lines at the bottom of `<UpcomingBlock>` are fed by
 * `occurrenceTotals`, which resolves an occurrence priced from its own settled
 * history to `'0'` — so that money was in neither figure, and nowhere else on
 * the home screen either.
 *
 * Asserted against the exported line rather than `<UpcomingBlock>`, which owns
 * four tRPC queries and cannot be rendered without a client — the same reason
 * `<VaultProgressRow>` is exported. SC-797 is a defect that shipped precisely
 * because a second render site was invisible to a green suite, and an exclusion
 * line is exactly the sort of thing that reaches one site and not the other.
 */
describe('UpcomingFootLine', () => {
  const RATES: BaseCurrencyRates = {
    baseCurrencyTokenId: 'token-eur',
    baseSymbol: 'EUR',
    rateByCurrencyTokenId: new Map(),
    ratesStatus: 'ready',
  };
  const TOKEN_SYMBOLS = new Map([['token-eur', 'EUR']]);

  /** A variable bill with nothing declared and nothing settled. Annotated
   *  rather than inferred: `expectedAmount: null` would otherwise narrow to
   *  the `null` LITERAL, and `DECLARED` below is that shape with an amount. */
  const ESTIMATED: EstimableOccurrence = {
    id: 'occurrence-power',
    dueDate: '2026-03-01',
    expectedAmount: null,
    actualAmount: null,
    payment: { id: 'payment-power', direction: 'outflow', currencyTokenId: 'token-eur' },
  };

  /** The same shape with an amount on it — the set that belongs IN a figure. */
  const DECLARED: EstimableOccurrence = {
    ...ESTIMATED,
    id: 'occurrence-hetzner',
    expectedAmount: '42.00',
    payment: { id: 'payment-hetzner', direction: 'outflow', currencyTokenId: 'token-eur' },
  };

  const POWER_ESTIMATE: ReadonlyMap<string, HistoryEstimate> = new Map([
    ['payment-power', { amount: '84.20', sourceDueDate: '2026-02-15' }],
  ]);
  const NO_HISTORY = new Map<string, HistoryEstimate>();

  function render(
    exclusionKey: string,
    occurrences: (typeof ESTIMATED)[],
    historyEstimates: ReadonlyMap<string, HistoryEstimate>
  ): string {
    return renderToStaticMarkup(
      <UpcomingFootLine
        label="Overdue, 1 bill"
        totals={occurrenceTotals(occurrences)}
        estimated={estimatedTotals(occurrences, historyEstimates)}
        exclusionKey={exclusionKey}
        tokenSymbolById={TOKEN_SYMBOLS}
        rates={RATES}
      />
    );
  }

  const OVERDUE_KEY = 'v3.money.upcoming.estimatedExcludedOverdue';
  const INCOME_KEY = 'v3.money.expectedIncome.estimatedExcluded';

  test('the overdue line names what its figure leaves out, with the amount', () => {
    const html = render(OVERDUE_KEY, [ESTIMATED], POWER_ESTIMATE);

    // The figure is still €0.00 — that is SC-807's ruling, not the defect — but
    // the €84.20 is now accounted for beside it rather than nowhere at all.
    expect(html).toInclude('€0.00');
    expect(html).toInclude('€84.20');
    expect(html).toInclude('Not included');
    expect(html).toInclude('1 overdue bill is estimated from its last settled amount');
    expect(html).toInclude('its real amount is still unknown');
  });

  test('the overdue line borrows the Money tab’s sentence, not the committed one', () => {
    // The same claim about the same set on two screens gets ONE key: two
    // spellings of one sentence is a drift hazard, and the day one is
    // retranslated the home screen and the Money tab would state different
    // facts about the same bills. The COMMITTED sentence stays off it, for the
    // reason SC-807 kept it off the tile this line mirrors.
    expect(render(OVERDUE_KEY, [ESTIMATED], POWER_ESTIMATE)).not.toInclude(
      'an estimate is not a commitment'
    );
  });

  test('the income line says what a forecast can say, and not what a bill says', () => {
    const html = render(INCOME_KEY, [ESTIMATED], POWER_ESTIMATE);

    expect(html).toInclude('€84.20');
    expect(html).toInclude('1 payment is estimated from its last settled amount');
    expect(html).toInclude('a past amount is not a forecast');
    // Neither bill sentence: nothing on an income figure is owed by the reader,
    // and nothing on it is late.
    expect(html).not.toInclude('an estimate is not a commitment');
    expect(html).not.toInclude('its real amount is still unknown');
  });

  test('the control: with nothing estimated there is no second line at all', () => {
    // The asymmetry, pinned. A permanent line reading €0.00 would assert a
    // category most books never have — and a conditional that never renders is
    // indistinguishable from one that cannot, unless the cases above prove it
    // does.
    const html = render(OVERDUE_KEY, [DECLARED], NO_HISTORY);

    expect(html).toInclude('€42.00');
    expect(html).not.toInclude('Not included');
    expect(html).not.toInclude('is estimated from its last settled amount');
  });

  test('the control: a declared bill is in the figure and in no exclusion', () => {
    // The case that catches the line firing off the wrong predicate: the
    // estimate is keyed to a payment that is not in this set.
    const html = render(OVERDUE_KEY, [DECLARED], POWER_ESTIMATE);

    expect(html).toInclude('€42.00');
    expect(html).not.toInclude('€84.20');
    expect(html).not.toInclude('Not included');
  });

  test('the figure counts the declared money and the line counts the rest', () => {
    // Both in one set, so the two numbers have to be different and neither may
    // be their sum — the same rule the Money tab's two lines obey.
    const html = render(OVERDUE_KEY, [DECLARED, ESTIMATED], POWER_ESTIMATE);

    expect(html).toInclude('€42.00');
    expect(html).toInclude('€84.20');
    expect(html).not.toInclude('€126.20');
  });
});

describe('Home net-worth change', () => {
  const range = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };
  const chart: HomeChart = {
    metric: 'net-worth',
    chooseMetric: () => {},
    metrics: HOME_METRICS,
    periodKey: '30d',
    choosePeriod: () => {},
    period: homePeriodByKey('30d'),
    range,
    returns: { request: { kind: 'custom', ...range }, view: null, pending: false },
  };

  test.each([
    ['130', '+$30.00', '+30.0%'],
    ['80', '−$20.00', '−20.0%'],
  ])(
    'shows the full change to %s without waiting for a contribution calculation',
    (total, amount, percent) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      client.setQueryData(
        getQueryKey(trpc.portfolio.getNetWorthSeries, { ...range, granularity: 'auto' }, 'query'),
        {
          series: [
            {
              date: '2026-08-01',
              totalValue: '100',
              holdingsTotal: 1,
              holdingsWithKnownValue: 1,
              holdingsUnpriceable: 0,
              holdingsStalePriced: 0,
              holdingsBasisUnknown: 0,
            },
            {
              date: '2026-08-30',
              totalValue: '110',
              holdingsTotal: 1,
              holdingsWithKnownValue: 1,
              holdingsUnpriceable: 0,
              holdingsStalePriced: 0,
              holdingsBasisUnknown: 0,
            },
          ],
          baseCurrencyId: 'USD',
          granularity: 'daily',
          unmeasuredDates: [],
        }
      );
      const trpcClient = trpc.createClient({
        links: [httpBatchLink({ url: 'http://localhost/trpc' })],
      });
      const html = renderToStaticMarkup(
        <trpc.Provider client={trpcClient} queryClient={client}>
          <QueryClientProvider client={client}>
            <StaticRouter location="/">
              <HeroBlock total={total} currency="USD" chart={chart} />
            </StaticRouter>
          </QueryClientProvider>
        </trpc.Provider>
      );
      client.clear();
      expect(html).toInclude(amount);
      expect(html).toInclude(percent);
      expect(html).toInclude('vs 30d');
      expect(html).not.toInclude('excluding');
    }
  );
});

/**
 * SC-1690: Home's hero lost its PnL and Returns tabs in SC-1669, and the peek
 * behind it said "Net worth" whichever tab was on.
 */
describe('Home hero keeps all three charts', () => {
  const range = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };
  const chartFor = (metric: HomeChart['metric']): HomeChart => ({
    metric,
    chooseMetric: () => {},
    metrics: HOME_METRICS,
    periodKey: '30d',
    choosePeriod: () => {},
    period: homePeriodByKey('30d'),
    range,
    returns: { request: { kind: 'custom', ...range }, view: null, pending: false },
  });

  function renderHomeHero(metric: HomeChart['metric']): string {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Answered, so each tab draws its chart rather than a loading skeleton.
    const input = { ...range, granularity: 'auto' } as const;
    const quality = {
      holdingsTotal: 1,
      holdingsWithKnownValue: 1,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
    };
    client.setQueryData(getQueryKey(trpc.portfolio.getNetWorthSeries, input, 'query'), {
      series: [
        { date: '2026-08-01', totalValue: '100', ...quality },
        { date: '2026-08-30', totalValue: '110', ...quality },
      ],
      baseCurrencyId: 'USD',
      granularity: 'daily',
      unmeasuredDates: [],
    });
    client.setQueryData(getQueryKey(trpc.portfolio.getPnLSeries, input, 'query'), {
      series: [
        { date: '2026-08-01', realizedPnl: '0', unrealizedPnl: '0', totalPnl: '0', ...quality },
        { date: '2026-08-30', realizedPnl: '2', unrealizedPnl: '8', totalPnl: '10', ...quality },
      ],
      baseCurrencyId: 'USD',
      granularity: 'daily',
    });
    const trpcClient = trpc.createClient({
      links: [httpBatchLink({ url: 'http://localhost/trpc' })],
    });
    const html = renderToStaticMarkup(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <StaticRouter location="/">
            <HeroBlock total="110" currency="USD" chart={chartFor(metric)} variant="compact" />
          </StaticRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
    client.clear();
    return html;
  }

  test('the tab control is on the Home card', () => {
    const html = renderHomeHero('net-worth');
    expect(html).toInclude('aria-label="Choose what to plot"');
    for (const label of ['Net worth', 'PnL', 'Returns']) expect(html).toInclude(`>${label}<`);
  });

  test('PnL chosen on Home shows the PnL figure, not net worth', () => {
    const html = renderHomeHero('pnl');
    expect(html).toInclude('Profit and loss · ');
  });

  test('the chart link names the chart it opens', () => {
    expect(renderHomeHero('pnl')).toInclude('aria-label="Open the profit and loss chart"');
    expect(renderHomeHero('net-worth')).toInclude('aria-label="Open the net worth chart"');
  });

  test('the peek is titled by the chosen chart', () => {
    expect(HOME_METRIC_TITLE_KEYS['net-worth']).toBe('v3.home.metric.netWorth');
    expect(HOME_METRIC_TITLE_KEYS.pnl).toBe('v3.home.metric.pnlFull');
    expect(HOME_METRIC_TITLE_KEYS.returns).toBe('v3.home.metric.returns');
  });
});

/**
 * SC-1692: the peek behind the Home chart repeated the card. It now shows
 * details for the chart that is on, over the period that is on.
 */
describe('Home chart peek shows details for the chosen chart', () => {
  const range = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };
  const chartFor = (metric: HomeChart['metric']): HomeChart => ({
    metric,
    chooseMetric: () => {},
    metrics: HOME_METRICS,
    periodKey: '30d',
    choosePeriod: () => {},
    period: homePeriodByKey('30d'),
    range,
    returns: { request: { kind: 'custom', ...range }, view: null, pending: false },
  });

  function renderDetails(metric: HomeChart['metric']): string {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(getQueryKey(trpc.portfolio.getPeriodBreakdown, range, 'query'), {
      startDate: '2026-08-01',
      endDate: '2026-08-30',
      total: { start: '1000', end: '1250', change: '250' },
      byAccountType: [
        {
          code: 'crypto_exchange',
          name: 'Crypto exchange',
          start: '400',
          end: '700',
          change: '300',
        },
        { code: 'checking', name: 'Checking', start: '600', end: '550', change: '-50' },
      ],
      topMovers: [
        {
          holdingId: 'h1',
          symbol: 'BTC',
          accountName: 'BTC account',
          start: '300',
          end: '580',
          change: '280',
        },
        {
          holdingId: 'h2',
          symbol: 'GBP',
          accountName: 'GBP account',
          start: '600',
          end: '550',
          change: '-50',
        },
      ],
      topPnl: [
        {
          holdingId: 'h1',
          symbol: 'BTC',
          accountName: 'BTC account',
          realized: '0',
          unrealized: '260',
          total: '260',
        },
        {
          holdingId: 'h3',
          symbol: 'VWRL',
          accountName: 'VWRL account',
          realized: '12',
          unrealized: '-40',
          total: '-28',
        },
      ],
    });
    const quality = {
      holdingsTotal: 1,
      holdingsWithKnownValue: 1,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
    };
    client.setQueryData(
      getQueryKey(trpc.portfolio.getPnLSeries, { ...range, granularity: 'auto' }, 'query'),
      {
        series: [
          { date: '2026-08-01', realizedPnl: '0', unrealizedPnl: '0', totalPnl: '0', ...quality },
          {
            date: '2026-08-30',
            realizedPnl: '12',
            unrealizedPnl: '220',
            totalPnl: '232',
            ...quality,
          },
        ],
        baseCurrencyId: 'USD',
        granularity: 'daily',
      }
    );
    // The returns tab reads the hero's own window, answered here.
    const returnsInput = { window: { kind: 'custom', ...range }, scope: undefined } as const;
    client.setQueryData(getQueryKey(trpc.portfolio.hasReturns, returnsInput, 'query'), {
      hasReturns: true,
    });
    client.setQueryData(getQueryKey(trpc.portfolio.getReturns, returnsInput, 'query'), {
      returns: {
        scope: { kind: 'user' },
        requestedWindow: { kind: 'custom', from: '2026-08-01', to: '2026-08-31' },
        effectiveWindow: { from: '2026-08-01', to: '2026-08-30' },
        baseCurrencyId: 'usd',
        startValue: '1000',
        endValue: '1250',
        netExternalFlow: '100',
        twr: {
          cumulative: '0.15',
          annualized: null,
          measuredPeriods: 29,
          skippedPeriods: 0,
          spanDays: 29,
        },
        xirr: { status: 'ok', rate: 0.2, method: 'bisection', iterations: 12, uniqueRoot: true },
        coverage: {
          measuredDays: 30,
          windowDays: 31,
          daysNotFullyCovered: 0,
          skippedPeriods: 0,
          unvaluedFlows: 0,
          staleValuedFlows: 0,
          flowsAfterLastMeasuredDay: 0,
        },
        attribution: null,
      },
      benchmarks: [{ key: 'btc', cumulative: '0.1' }],
    });
    const trpcClient = trpc.createClient({
      links: [httpBatchLink({ url: 'http://localhost/trpc' })],
    });
    const html = renderToStaticMarkup(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <AuthContext.Provider
            value={
              { user: { id: 'user-1' }, status: 'authenticated' } as unknown as AuthContextType
            }
          >
            <BaseCurrencyProvider>
              <StaticRouter location="/home/hero">
                <HeroDetails chart={chartFor(metric)} currency="USD" />
              </StaticRouter>
            </BaseCurrencyProvider>
          </AuthContext.Provider>
        </QueryClientProvider>
      </trpc.Provider>
    );
    client.clear();
    return html;
  }

  test('no tab repeats the card: there is no chart picker in the peek', () => {
    for (const metric of ['net-worth', 'pnl', 'returns'] as const) {
      expect(renderDetails(metric)).not.toInclude('aria-label="Choose what to plot"');
    }
  });

  test('net worth shows the change by account type and the top movers', () => {
    const html = renderDetails('net-worth');
    expect(html).toInclude('Change by account type');
    expect(html).toInclude('Crypto exchange');
    expect(html).toInclude('Checking');
    expect(html).toInclude('Top movers');
    expect(html).toInclude('BTC');
    expect(html).not.toInclude('Top holdings by PnL');
  });

  test('PnL shows realized against unrealized and the top holdings by PnL', () => {
    const html = renderDetails('pnl');
    expect(html).toInclude('Realized vs unrealized');
    expect(html).toInclude('Top holdings by PnL');
    expect(html).toInclude('VWRL');
    expect(html).not.toInclude('Change by account type');
  });

  test('returns shows the returns details, not the net worth breakdown', () => {
    const html = renderDetails('returns');
    expect(html).not.toInclude('Change by account type');
    expect(html).not.toInclude('Top holdings by PnL');
    // Both rates, time-weighted and money-weighted, are in the peek.
    expect(html).toInclude('Investment return');
    expect(html).toInclude('Your money&#x27;s return');
    // Open, not behind "The rates behind this": in the peek they are the point.
    expect(html).toMatch(/<details[^>]*\sopen/);
  });

  test('a mover names its account, so one token in two accounts reads as two rows', () => {
    const html = renderDetails('net-worth');
    expect(html).toInclude('BTC account');
    expect(html).toInclude('GBP account');
  });
});
