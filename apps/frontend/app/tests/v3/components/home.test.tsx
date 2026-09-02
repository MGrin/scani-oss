import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { CoverageNote } from '../../../src/v3/components/home/CoverageNote';
import { DisclosureButton } from '../../../src/v3/components/home/DisclosureButton';
import {
  type FirstRunJob,
  FirstRunPanel,
  resolveFirstRunState,
} from '../../../src/v3/components/home/FirstRunPanel';
import { formatChartDate } from '../../../src/v3/components/home/PortfolioChart';
import { UpcomingFootLine } from '../../../src/v3/components/home/UpcomingBlock';
import { VaultProgressRow } from '../../../src/v3/components/home/VaultsBlock';
import type { FigureQuality, VaultRow } from '../../../src/v3/lib/home';
import {
  type EstimableOccurrence,
  estimatedTotals,
  occurrenceTotals,
} from '../../../src/v3/lib/money';
import type { HistoryEstimate } from '../../../src/v3/lib/paymentTotals';

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
    expect(html).toInclude('Realized PnL excludes 3 unconfirmed transfers');
  });

  test('the whole sentence is the tap target, not a word inside it', () => {
    // At 390px a two-word target inside a caption is the one thing in this
    // block a thumb misses, and the sentence already names where it goes.
    const anchor = /<a [^>]*>([^<]*)<\/a>/.exec(renderNote({ ...FULL, transfersUnreviewed: 2 }));
    expect(anchor?.[1]).toBe('Realized PnL excludes 2 unconfirmed transfers');
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
    // The screenshot is named before the file: `screenshot-parse` has run 12
    // times in production and `file-import` has never run at all.
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
