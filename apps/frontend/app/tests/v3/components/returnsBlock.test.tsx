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
      windowKey="all"
      onWindowChange={() => undefined}
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
  test('the first figure is the change in money, with the period attached', () => {
    const html = render(VIEW);
    // The money and its period, not a rate: this is the whole ticket.
    expect(html).toContain('12,400');
    expect(html).toContain('20 Mar 2025');
    // And the rates are NOT in the open part of the card.
    const [open] = html.split(copy.details);
    expect(open).not.toContain('70.2');
    expect(open).not.toContain('44.5');
  });

  test('a fall is said in words, not left to the colour', () => {
    const html = render({ ...VIEW, money: { ...MONEY, change: -3000, gain: -8000 } });
    expect(html).toContain('Down ');
    expect(html).toContain('3,000');
  });

  test('the attribution bar names what went in and what the portfolio did', () => {
    const html = render(VIEW);
    expect(html).toContain(copy.attribution.contributed);
    expect(html).toContain(copy.attribution.market);
    expect(html).toContain(copy.attribution.currency);
    expect(html).toContain('6,200');
    expect(html).toContain('1,200');
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

  test('the chart failing leaves the sentence, the bar and one line of text', () => {
    const html = render(VIEW, null, true);
    expect(html).toContain('12,400');
    expect(html).toContain(copy.attribution.contributed);
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
