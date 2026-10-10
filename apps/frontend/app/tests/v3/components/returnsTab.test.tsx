import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReturnsCard } from '../../../src/v3/components/home/ReturnsBlock';
import { ReturnsHeroChart } from '../../../src/v3/components/home/ReturnsHeroChart';
import { ReturnsHeroTile } from '../../../src/v3/components/home/ReturnsHeroTile';
import en from '../../../src/v3/i18n/locales/en.json';
import type { ReturnsMoney, ReturnsView } from '../../../src/v3/lib/returns';
import type { ComparisonView } from '../../../src/v3/lib/returns-comparison';

/**
 * Returns as the home chart's third tab (SC-1301), in the tile its siblings
 * use (SC-1305).
 *
 * The hero takes the money figure and the comparison chart; the block below
 * keeps the attribution bar and the ahead/behind rows. That shape puts the
 * SAME figure within reach of two code paths on one screen, which is the
 * failure this file exists to hold shut: two copies of one number, updated by
 * two paths, eventually disagree.
 *
 * ## The guard was re-aimed, not deleted (SC-1305)
 *
 * It used to count the money SENTENCE — the literal `Up ` that opens
 * `ReturnsHeadline`. SC-1305 replaced the hero's sentence with a `StatTile`,
 * so that marker stopped appearing in the hero and a count of one would have
 * been satisfied by the card alone whether or not the hero rendered anything.
 * The wording changed; the hazard did not. So the count is now over the
 * FIGURE, which is the thing that must not exist twice, and each path is
 * asserted present on the state that owns it.
 *
 * Both pieces render without a tRPC client on purpose — they are handed their
 * data — so the screen's actual composition can be asserted here rather than
 * by staring at it.
 */

const copy = en.v3.home.returns;
const heroCopy = en.v3.home.hero;

const MONEY: ReturnsMoney = {
  change: 76_296,
  contributed: 5000,
  gain: 71_296,
  market: 70_000,
  currency: 1296,
  from: '2025-12-31',
  unvalued: 0,
};

const VIEW: ReturnsView = {
  twr: { cumulative: 70.2, annualized: 42.5 },
  xirr: { rate: 44.5, approximate: false },
  fx: null,
  benchmarks: [],
  since: null,
  partial: false,
  money: MONEY,
};

/**
 * No value here may CONTAIN the money figure as a substring.
 *
 * `countFigures` splits on `71,296`, so a portfolio point of `171,296` — which
 * is what this fixture carried until SC-1305 — would be counted as a second
 * copy of the hero's figure the moment anything rendered an axis tick. The
 * count is the guard; a fixture that can inflate it is the guard reporting a
 * number it did not measure.
 */
const COMPARISON: ComparisonView = {
  points: [
    { date: '2025-12-31', portfolio: 100_000, btc: 100_000, sp500: null, us_inflation: 100_000 },
    { date: '2026-09-19', portfolio: 180_000, btc: 108_200, sp500: 104_000, us_inflation: 103_000 },
  ],
  lines: ['btc', 'sp500', 'us_inflation'],
  gaps: [
    { key: 'btc', money: 4200, cumulative: 8.2 },
    { key: 'sp500', money: -1600, cumulative: 4 },
  ],
  truncated: false,
};

/** `renderToStaticMarkup` escapes `&`, and three of these strings say "S&P". */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;');
}

/** The investment gain as it is printed, whichever path printed it. */
const FIGURE = '71,296';

function countFigures(html: string): number {
  return html.split(FIGURE).length - 1;
}

/** The sentence's opening word — `Up `, before the figure `<Trans>` splices in. */
const SENTENCE = 'Up ';

function renderScreen({
  returnsTab,
  view = VIEW,
  comparison = COMPARISON,
  comparisonPending = false,
  comparisonFailed = false,
}: {
  returnsTab: boolean;
  view?: ReturnsView;
  comparison?: ComparisonView | null;
  comparisonPending?: boolean;
  comparisonFailed?: boolean;
}): string {
  return renderToStaticMarkup(
    <>
      {/* Exactly the two pieces `HeroBlock` mounts for this tab, in its
          order: the stat tile in the figure slot, the chart below the metric
          control. */}
      {returnsTab ? (
        <>
          <ReturnsHeroTile view={view} currency="GBP" periodSuffixKey="v3.home.period.suffix30d" />
          <ReturnsHeroChart
            comparison={comparison}
            comparisonPending={comparisonPending}
            comparisonFailed={comparisonFailed}
            currency="GBP"
          />
        </>
      ) : null}
      <ReturnsCard
        view={view}
        comparison={comparison}
        comparisonFailed={comparisonFailed}
        currency="GBP"
        promotedToHero={returnsTab}
      />
    </>
  );
}

describe('the money figure appears exactly once, whichever tab is on', () => {
  test('with Returns selected the hero carries it and the block below does not', () => {
    const html = renderScreen({ returnsTab: true });
    expect(countFigures(html)).toBe(1);
    // And it is the HERO's copy: the card's sentence is the other path, and
    // a count of one would also be satisfied by the card alone.
    expect(html).not.toContain(SENTENCE);
  });

  test('with any other tab selected the block below still says it', () => {
    const html = renderScreen({ returnsTab: false });
    expect(countFigures(html)).toBe(1);
    expect(html).toContain(SENTENCE);
  });

  test('the bar and the ahead/behind rows stay below in both states', () => {
    for (const returnsTab of [true, false]) {
      const html = renderScreen({ returnsTab });
      expect(html).toContain(copy.attribution.label);
      expect(html).toContain(copy.gaps.label);
      expect(html).toContain('vs Bitcoin');
    }
  });
});

describe('the Returns hero is a stat tile', () => {
  test('the label names the period, the way the PnL tile names its own', () => {
    const html = renderScreen({ returnsTab: true });
    expect(html).toContain('Returns · 30d');
  });

  test('the percentage is the delta beneath the money, and says which rate it is', () => {
    const html = renderScreen({ returnsTab: true });
    expect(html).toContain('70.2');
    // The money change includes contributions and the rate excludes them, so
    // an unlabelled percent under a money figure reads as that figure as a
    // rate. Naming it is what stops that.
    expect(html).toContain(copy.twr.label);
  });

  test('a window whose history starts late says SINCE instead of the period', () => {
    // `view.since` is non-null only when the measured days begin after the
    // range the reader picked, so this is the one case where the label tells
    // them something the period control does not already say.
    const html = renderScreen({ returnsTab: true, view: { ...VIEW, since: '2025-12-31' } });
    expect(html).toContain('Returns · since');
    expect(html).not.toContain('Returns · 30d');
  });

  test('no rate yet is said, not left as a blank delta', () => {
    const html = renderScreen({ returnsTab: true, view: { ...VIEW, twr: null } });
    expect(html).toContain(heroCopy.returnsNoRate);
  });
});

describe('one control, and the card gives its picker up', () => {
  // The picker is the card's control since SC-1668, mounted by `ReturnsBlock`
  // only while the hero does not own the window, so the card body never
  // draws one of its own.
  test('the card hides its own window picker while the hero owns the window', async () => {
    expect(renderScreen({ returnsTab: true })).not.toContain(copy.chooseWindow);
    expect(renderScreen({ returnsTab: false })).not.toContain(copy.chooseWindow);
    const source = await Bun.file(
      new URL('../../../src/v3/components/home/ReturnsBlock.tsx', import.meta.url)
    ).text();
    expect(source).toMatch(/controls=\{\s*heroWindow === null \? \(\s*<ReturnsWindowPicker/);
  });

  test('the comparison chart moves up rather than being drawn twice', () => {
    const promoted = renderScreen({ returnsTab: true });
    expect(promoted.split(esc(copy.chart.label))).toHaveLength(2);
    // And the block below keeps drawing it when the hero is not.
    expect(renderScreen({ returnsTab: false }).split(esc(copy.chart.label))).toHaveLength(2);
  });
});

describe('the hero renders its figure before the chart can', () => {
  test('a pending comparison leaves the figure standing', () => {
    const html = renderScreen({ returnsTab: true, comparison: null, comparisonPending: true });
    expect(countFigures(html)).toBe(1);
    expect(html).toContain(esc(heroCopy.returnsChartPending));
  });

  test('a failed comparison leaves the figure and says one line', () => {
    const html = renderScreen({ returnsTab: true, comparison: null, comparisonFailed: true });
    expect(countFigures(html)).toBe(1);
    expect(html).toContain(copy.chart.unavailable);
  });

  test('too few measured days is said, not left as an empty frame', () => {
    const html = renderScreen({
      returnsTab: true,
      comparison: { ...COMPARISON, points: [] },
    });
    expect(html).toContain(heroCopy.returnsNoChart);
  });
});

/**
 * The caption that named a WIDER window is gone, because nothing widens any
 * more (SC-1305). Asserted rather than assumed: a caption saying "measured
 * over 1Y" under a 1M axis was the defect reporting itself while reading as an
 * explanation, and reinstating it would be a regression that looks like copy.
 */
describe('nothing is widened, so nothing says it was', () => {
  test('the hero carries no widened-window caption', () => {
    expect(renderScreen({ returnsTab: true })).not.toContain('Measured over');
  });
});

/**
 * SC-1406: a figure the engine withholds keeps the tab, so the tile has to say
 * why rather than show a dash.
 */
describe('a withheld figure says why in the tile', () => {
  test('the first reason is shown in place of the figure', () => {
    const html = renderToStaticMarkup(
      <ReturnsHeroTile
        view={{ ...VIEW, money: null, twr: null, unavailableReasons: ['rebuilding-history'] }}
        currency="GBP"
        periodSuffixKey="v3.home.period.suffix30d"
      />
    );
    expect(html).toContain(copy.eligibility['rebuilding-history']);
    expect(html).not.toContain(FIGURE);
  });

  test('the control: an eligible figure shows no reason', () => {
    const html = renderToStaticMarkup(
      <ReturnsHeroTile view={VIEW} currency="GBP" periodSuffixKey="v3.home.period.suffix30d" />
    );
    expect(html).not.toContain(copy.eligibility['rebuilding-history']);
    expect(html).toContain(FIGURE);
  });
});
