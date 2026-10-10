import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReturnsCard } from '../../../src/v3/components/home/ReturnsBlock';
import en from '../../../src/v3/i18n/locales/en.json';
import type { ReturnsView } from '../../../src/v3/lib/returns';
import type { ComparisonView } from '../../../src/v3/lib/returns-comparison';

const copy = en.v3.home.returns;

function render(
  view: ReturnsView | null,
  comparison: ComparisonView | null = null,
  comparisonFailed = false
): string {
  return renderToStaticMarkup(
    <ReturnsCard
      view={view}
      comparison={comparison}
      comparisonFailed={comparisonFailed}
      currency="GBP"
    />
  );
}

const MONEY: NonNullable<ReturnsView['money']> = {
  change: 12400,
  contributed: 5000,
  gain: 7400,
  market: 6200,
  currency: 1200,
  from: '2025-03-20',
  unvalued: 0,
};

const VIEW: ReturnsView = {
  twr: { cumulative: 70.2, annualized: 42.5 },
  xirr: { rate: 44.5, approximate: false },
  fx: null,
  benchmarks: [],
  since: '2025-03-20',
  partial: false,
  money: MONEY,
};

const COMPARISON: ComparisonView = {
  points: [
    { date: '2025-03-20', portfolio: 100000, btc: 100000, sp500: null, us_inflation: 100000 },
    { date: '2026-09-19', portfolio: 112400, btc: 108200, sp500: 104000, us_inflation: 103000 },
  ],
  lines: ['btc', 'sp500', 'us_inflation'],
  gaps: [
    { key: 'btc', money: 4200, cumulative: 8.2 },
    { key: 'sp500', money: -1600, cumulative: 4 },
  ],
  truncated: false,
};

describe('the returns card leads with money (SC-1297)', () => {
  test('the first figure is the investment gain in money, with the period attached', () => {
    const html = render(VIEW);
    // The gain and its period, not a rate, and not the total change: new
    // money is not performance (SC-1396).
    expect(html).toContain('7,400');
    expect(html).not.toContain('12,400');
    expect(html).toContain('20 Mar 2025');
    // And the rates are NOT in the open part of the card.
    const [open] = html.split(copy.details);
    expect(open).not.toContain('70.2');
    expect(open).not.toContain('44.5');
  });

  test('a fall is said in words, not left to the colour', () => {
    const html = render({ ...VIEW, money: { ...MONEY, change: -3000, gain: -8000 } });
    expect(html).toContain('Down ');
    expect(html).toContain('8,000');
  });

  test('the attribution bar splits the headline gain into market and currency', () => {
    const html = render(VIEW);
    expect(html).toContain(copy.attribution.market);
    expect(html).toContain(copy.attribution.currency);
    expect(html).toContain('6,200');
    expect(html).toContain('1,200');
  });

  // SC-1425: the list summed to gain + deposits under a headline that is the
  // gain alone. The bar's own rows must add up to the headline, and what the
  // reader moved is said outside them.
  test('deposits are a caption outside the bar, never one of its parts', () => {
    const html = render(VIEW);
    const bar = html.slice(html.indexOf('data-ui="attribution-bar"'), html.indexOf('<dl'));
    expect(bar.match(/background-color/g) ?? []).toHaveLength(2);
    const list = html.slice(html.indexOf('<dl'), html.indexOf('</dl>'));
    expect(list).not.toContain('5,000');
    const moved = html.slice(html.indexOf('data-ui="attribution-moved"'));
    expect(moved).toContain('Not in the figure above: you put in');
    expect(moved).toContain('5,000');
  });

  test('a withdrawal reads as taken out, and no deposit means no caption', () => {
    const out = render({ ...VIEW, money: { ...MONEY, contributed: -3000, change: 4400 } });
    expect(out).toContain('you took out');
    expect(out).toContain('3,000');
    expect(render({ ...VIEW, money: { ...MONEY, contributed: 0, change: 7400 } })).not.toContain(
      'data-ui="attribution-moved"'
    );
  });

  test('an unsplittable gain is one segment, never a confident zero', () => {
    const html = render({ ...VIEW, money: { ...MONEY, market: null, currency: null } });
    expect(html).toContain(copy.attribution.combined);
    expect(html).not.toContain(copy.attribution.market.concat('</span>'));
    // The whole gain is still shown under the combined label.
    expect(html).toContain('7,400');
  });

  test('flows the engine could not value are said, and only when there are some', () => {
    expect(render(VIEW)).not.toContain('could not be valued');
    const html = render({ ...VIEW, money: { ...MONEY, unvalued: 2 } });
    expect(html).toContain('2 movements could not be valued');
  });

  test('the ahead/behind rows lead with money and caption with the percentage', () => {
    const html = render(VIEW, COMPARISON);
    expect(html).toContain(copy.gaps.label);
    // "vs" is what makes the money a comparison rather than the benchmark's
    // own figure — the exact ambiguity the rates version shipped with.
    expect(html).toContain('vs Bitcoin');
    expect(html).toContain('4,200');
    expect(html).toContain('1,600');
    expect(html).toContain('8.2');
  });

  test('each figure says what it measures, so a gap and a return cannot read as one (SC-1430)', () => {
    const text = render(VIEW, COMPARISON).replace(/<[^>]+>/g, '');
    // The gap is a distance in words, unsigned: ahead of Bitcoin, behind the S&P 500.
    expect(text).toContain('£4,200.00 ahead');
    expect(text).toContain('£1,600.00 behind');
    expect(text).not.toContain('−£1,600.00');
    // The percentage is labelled as a return; the row's label already names
    // the benchmark, so the sub-line does not repeat it.
    expect(text).toContain('Returned 8.2%');
    expect(text).toContain('Returned 4.0%');
    expect(text).not.toContain('Bitcoin returned');
    // Control: the tones still separate the two directions.
    const html = render(VIEW, COMPARISON);
    expect(html).toMatch(/text-gain[^>]*>(?:<[^>]+>)*£4,200\.00/);
    expect(html).toMatch(/text-loss[^>]*>(?:<[^>]+>)*£1,600\.00/);
  });

  test('a long benchmark name wraps rather than ending in an ellipsis (SC-1430)', () => {
    const html = render(VIEW, COMPARISON);
    const label = html.match(/<dt[^>]*>(?:<!--.*?-->)?vs Bitcoin/)?.[0] ?? '';
    // Control: the row was found, so the assertion below is about it.
    expect(label).toContain('vs Bitcoin');
    expect(label).not.toMatch(/truncate|line-clamp/);
  });

  test('the chart failing leaves the sentence, the bar and one line of text', () => {
    const html = render(VIEW, null, true);
    expect(html).toContain('7,400');
    expect(html).toContain(copy.attribution.label);
    expect(html).toContain(copy.chart.unavailable);
    // Control: a chart that simply has not arrived yet says nothing at all.
    expect(render(VIEW, null, false)).not.toContain(copy.chart.unavailable);
  });

  test('the rates are kept, behind Details', () => {
    const html = render({ ...VIEW, fx: { asset: 61.5, currency: 5.4 } });
    expect(html).toContain(copy.details);
    expect(html).toContain(copy.twr.label);
    expect(html).toContain(copy.xirr.label.replace("'", '&#x27;'));
    expect(html).toContain(copy.fx.label);
    expect(html).toContain('70.2');
    expect(html).toContain('44.5');
    expect(html).toContain('61.5');
  });

  test('a partly priced window still says so', () => {
    expect(render({ ...VIEW, partial: true })).toContain(copy.partial);
  });

  test('no money to report falls back to the rates, rather than to dashes', () => {
    const html = render({ ...VIEW, money: null });
    expect(html).toContain('70.2');
    expect(html).not.toContain(copy.attribution.label);
  });
});

describe('a return over part of the scope says which part (SC-1421)', () => {
  const SUBSET: NonNullable<ReturnsView['subset']> = {
    included: 17,
    measured: 116,
    excluded: [
      { reason: 'incomplete-flow-coverage', holdings: 91 },
      { reason: 'missing-valuation', holdings: 58 },
    ],
    excludedValue: 95000,
    valueShare: 0.134,
    valueBase: 'scope',
    enteredLate: 0,
    unpricedAtZero: 0,
  };

  test('the card names how many holdings it covers, what was left out and why', () => {
    const html = render({ ...VIEW, subset: SUBSET });
    expect(html).toContain('Covers 13% of the value, 17 of 116 holdings.');
    expect(html).toContain(copy.leftOut);
    expect(html).toContain(`${copy.eligibility['incomplete-flow-coverage']} (91)`);
    expect(html).toContain(`${copy.eligibility['missing-valuation']} (58)`);
    expect(html).toContain('95,000');
  });

  // SC-1439: over the whole portfolio the base is the net worth, and the
  // card names it so the share is not read as a slice of something larger.
  test('the whole portfolio names its base as the net worth', () => {
    const html = render({ ...VIEW, subset: { ...SUBSET, valueBase: 'netWorth' } });
    expect(html).toContain('Covers 13% of your net worth, 17 of 116 holdings.');
    expect(html).not.toContain('of the value');
  });

  // SC-1439: the coverage line sits under the figure it qualifies, once, and
  // the foot keeps only what was left out and why.
  test('the coverage line comes before the breakdown, and only once', () => {
    const html = render({ ...VIEW, subset: SUBSET });
    const covers = html.indexOf('Covers 13% of the value');
    expect(covers).toBeGreaterThan(-1);
    expect(covers).toBeLessThan(html.indexOf(copy.leftOut));
    expect(html.split('Covers 13% of the value').length - 1).toBe(1);
  });

  test('a return over the whole scope says nothing about a subset', () => {
    const html = render({ ...VIEW, subset: null });
    expect(html).not.toContain('Covers ');
    expect(html).not.toContain(copy.leftOut);
  });
  // SC-1427: IBKR positions held before the Flex statement enter on its first
  // day. Nothing was left out, so the note is that sentence alone.
  test('holdings that entered at their statement date are named, alone when nothing was left out', () => {
    const html = render({
      ...VIEW,
      subset: {
        included: 116,
        measured: 116,
        excluded: [],
        excludedValue: 0,
        valueShare: 1,
        valueBase: 'scope',
        enteredLate: 13,
        unpricedAtZero: 0,
      },
    });
    expect(html).toContain('Counted from their first statement date: 13 holdings.');
    expect(html).not.toContain('Covers ');
    expect(html).not.toContain(copy.leftOut);
  });

  test('and after what was left out, when something was', () => {
    const html = render({ ...VIEW, subset: { ...SUBSET, enteredLate: 1 } });
    expect(html).toContain(copy.leftOut);
    expect(html).toContain('Counted from their first statement date: 1 holding.');
  });

  // SC-1428: airdrops nothing prices count at zero, and the note says how many.
  test('tokens counted at zero are named, beside what entered late', () => {
    const html = render({ ...VIEW, subset: { ...SUBSET, enteredLate: 1, unpricedAtZero: 58 } });
    expect(html).toContain('Counted from their first statement date: 1 holding.');
    expect(html).toContain('58 unpriced tokens counted at zero.');
  });

  test('alone, when nothing was left out', () => {
    const html = render({
      ...VIEW,
      subset: { ...SUBSET, excluded: [], enteredLate: 0, unpricedAtZero: 1 },
    });
    expect(html).toContain('1 unpriced token counted at zero.');
    expect(html).not.toContain(copy.leftOut);
  });
});

describe('a stored result during a rebuild says when it is from (SC-1694)', () => {
  const STORED: ReturnsView = {
    ...VIEW,
    asOf: '2026-10-11T08:30:00.000Z',
    updatingReasons: ['rebuilding-history'],
  };

  test('it names the time and the reason, under the figure', () => {
    const html = render(STORED);
    const asOf = html.indexOf('As of ');
    expect(asOf).toBeGreaterThan(-1);
    expect(html).toContain(copy.eligibility['rebuilding-history']);
    expect(asOf).toBeLessThan(html.indexOf(copy.details));
  });

  test('it is not the unavailable view: the figures stay', () => {
    const html = render(STORED);
    expect(html).not.toContain(copy.unavailable);
    expect(html).toContain('70.2');
  });

  test('a fresh result carries no as-of line', () => {
    expect(render(VIEW)).not.toContain('As of ');
  });
});
