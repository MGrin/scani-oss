import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { DeltaPill } from '@scani/ui/v3/components/charts/DeltaPill';
import { resolveSparklineTone } from '@scani/ui/v3/components/charts/Sparkline';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { ALLOCATION_OTHER_KEY } from '@scani/ui/v3/lib/chart';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { AllocationBar } from '../../../src/v3/components/charts/AllocationBar';
import { DebtLine } from '../../../src/v3/components/charts/DebtLine';
import { ShareRows } from '../../../src/v3/components/charts/ShareRows';

/**
 * `<Sparkline>` and `<ChartFrame>` are exercised by their pure parts only.
 * recharts sizes itself from a ResizeObserver against a measured parent, which
 * server rendering has neither of — the markup it produces here is an empty
 * container regardless of the data, so asserting on it would test nothing. The
 * rendered result is verified by screenshot at `/v3/kitchen-sink`.
 */

const ALLOCATION = [
  { key: 'crypto', label: 'Crypto', value: 52_000 },
  { key: 'stocks', label: 'Stocks', value: 31_000 },
  { key: 'cash', label: 'Cash', value: 17_000 },
];

describe('AllocationBar', () => {
  test('renders one bar segment and one list row per part', () => {
    const html = renderToStaticMarkup(
      <AllocationBar items={ALLOCATION} currency="USD" label="Allocation by type" />
    );
    for (const part of ALLOCATION) expect(html).toInclude(part.label);
    expect(html.match(/--chart-\d/g)).toHaveLength(6);
  });

  test('the bar is a labelled image and the list carries the values', () => {
    // Three of the light palette steps sit below 3:1 on a white page, which
    // obligates a relief channel. The list is it — dropping it would break the
    // palette's own terms, not just the layout.
    const html = renderToStaticMarkup(
      <AllocationBar items={ALLOCATION} currency="USD" label="Allocation by type" />
    );
    expect(html).toInclude('aria-label="Allocation by type"');
    expect(html).toInclude('role="img"');
    expect(html).toInclude('$52K');
    expect(html).toInclude('52%');
    // The size role survives the colour merged in after it — see cn.ts.
    expect(html).toInclude('text-caption text-muted-foreground');
  });

  test('segments grow in proportion, so the 2px gaps cannot distort them', () => {
    const html = renderToStaticMarkup(
      <AllocationBar items={[{ key: 'a', label: 'A', value: 1 }]} currency="USD" label="One" />
    );
    expect(html).toInclude('flex:1 0 0px');
    expect(html).toInclude('gap-[2px]');
  });

  test('names how many parts a fold stands for', () => {
    const html = renderToStaticMarkup(
      <AllocationBar
        items={Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, value: 10 }))}
        currency="USD"
        label="Allocation"
      />
    );
    expect(html).toInclude('Other');
    expect(html).toInclude('· 4');
  });

  test('nothing to allocate renders nothing at all', () => {
    expect(renderToStaticMarkup(<AllocationBar items={[]} currency="USD" label="x" />)).toBe('');
  });

  /**
   * Given somewhere to send the reader, every row that has a destination
   * becomes a link (SC-74). Omitted, the list stays the inert legend it is on a
   * summary of the list the reader is already looking at.
   */
  test('without a resolver the list is inert text', () => {
    const html = renderToStaticMarkup(
      <AllocationBar items={ALLOCATION} currency="USD" label="Allocation by type" />
    );
    expect(html).not.toInclude('<a');
  });

  test('with a resolver each addressable row is a link, and the rest stay text', () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/">
        <AllocationBar
          items={ALLOCATION}
          currency="USD"
          label="Allocation by type"
          itemHref={(segment) => (segment.key === 'cash' ? null : `/holdings?t=${segment.key}`)}
        />
      </StaticRouter>
    );
    expect(html).toInclude('href="/holdings?t=crypto"');
    expect(html).toInclude('href="/holdings?t=stocks"');
    expect(html).not.toInclude('t=cash');
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toInclude('hover:bg-surface-hover');
  });

  // The fold stands for several parts at once, so it addresses no record and
  // the block's resolver returns null for it — asserted here because the bar is
  // what has to honour that rather than linking it anyway.
  test('a fold the resolver refuses is left as text', () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/">
        <AllocationBar
          items={Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, value: 10 }))}
          currency="USD"
          label="Allocation"
          itemHref={(segment) =>
            segment.key === ALLOCATION_OTHER_KEY ? null : `/holdings?t=${segment.key}`
          }
        />
      </StaticRouter>
    );
    expect(html).toInclude('Other');
    expect(html.match(/<a /g)).toHaveLength(5);
  });
});

/**
 * Margin debt under an allocation bar (SC-1463). The line exists only when
 * there is debt: a "0.00" row under every bar would be a claim about a loan
 * nobody took, and the committed visual baselines have none.
 */
describe('DebtLine', () => {
  test('renders the label and the signed figure', () => {
    const html = renderToStaticMarkup(<DebtLine value={-1200} currency="USD" underLegend />);
    expect(html).toInclude('>Debt<');
    expect(html).toInclude('−$1,200.00');
    expect(html).toInclude('data-ui="debt"');
  });

  test('with no legend above it, the line drops the swatch indent and the legend column', () => {
    const standalone = renderToStaticMarkup(
      <DebtLine value={-1200} currency="USD" underLegend={false} />
    );
    const legend = renderToStaticMarkup(<DebtLine value={-1200} currency="USD" underLegend />);
    expect(standalone).toInclude('justify-between');
    expect(standalone).not.toInclude('size-2.5');
    expect(standalone).toInclude('−$1,200.00');
    expect(legend).toInclude('size-2.5');
    expect(legend).not.toInclude('justify-between');
  });

  test('margin debt and loans together list each part under the one Debt line (SC-1640)', () => {
    const html = renderToStaticMarkup(
      <DebtLine value={-5200} liabilities={-4000} currency="USD" underLegend />
    );
    expect(html).toInclude('−$5,200.00');
    expect(html).toInclude('Margin');
    expect(html).toInclude('−$1,200.00');
    expect(html).toInclude('Loans and cards');
    expect(html).toInclude('−$4,000.00');
  });

  test('with only one kind of debt there is no breakdown', () => {
    const loansOnly = renderToStaticMarkup(
      <DebtLine value={-4000} liabilities={-4000} currency="USD" underLegend />
    );
    expect(loansOnly).toInclude('−$4,000.00');
    expect(loansOnly).not.toInclude('Loans and cards');
    expect(loansOnly).not.toInclude('Margin');
  });

  test('no debt renders nothing at all', () => {
    expect(renderToStaticMarkup(<DebtLine value={0} currency="USD" underLegend={false} />)).toBe(
      ''
    );
  });
});

describe('AllocationBar share caption', () => {
  test('is absent unless asked for', () => {
    const html = renderToStaticMarkup(
      <AllocationBar items={ALLOCATION} currency="USD" label="Allocation by type" />
    );
    expect(html).not.toInclude('Share of assets');
  });

  test('renders above the legend when set', () => {
    const html = renderToStaticMarkup(
      <AllocationBar
        items={ALLOCATION}
        currency="USD"
        label="Allocation by type"
        shareCaption="Share of assets"
      />
    );
    expect(html.indexOf('Share of assets')).toBeGreaterThan(html.indexOf('role="img"'));
    expect(html.indexOf('Share of assets')).toBeLessThan(html.indexOf('<ul'));
  });
});

/**
 * The group cut (SC-1469). Groups overlap, so the rows are each a share of the
 * whole rather than parts of a split: no stacked bar, and two groups holding
 * the same 600 of a 1,000 portfolio both read 60%.
 */
describe('ShareRows', () => {
  const OVERLAPPING = [
    { key: 'a', label: 'Long term', value: 600, share: 0.6 },
    { key: 'b', label: 'Crypto', value: 600, share: 0.6 },
  ];

  test('draws no stacked bar', () => {
    const html = renderToStaticMarkup(
      <ShareRows rows={OVERLAPPING} currency="USD" label="Groups" note={null} />
    );
    expect(html).not.toInclude('data-ui="allocation-bar"');
    expect(html).not.toMatch(/--chart-\d/);
  });

  test('each row states its own share, so overlapping rows can sum past 100%', () => {
    const html = renderToStaticMarkup(
      <ShareRows rows={OVERLAPPING} currency="USD" label="Groups" note={null} />
    );
    expect(html.match(/width:60%/g)).toHaveLength(2);
    expect(html.replace(/width:60%/g, '').match(/60%/g)).toHaveLength(2);
  });

  test('a share above the whole fills the meter and says its real figure', () => {
    const html = renderToStaticMarkup(
      <ShareRows
        rows={[{ key: 'a', label: 'A', value: 1500, share: 1.5 }]}
        currency="USD"
        label="Groups"
        note={null}
      />
    );
    expect(html).toInclude('width:100%');
    expect(html).toInclude('150%');
  });

  test('an unknown share draws no meter', () => {
    const html = renderToStaticMarkup(
      <ShareRows
        rows={[{ key: 'a', label: 'A', value: 10, share: null }]}
        currency="USD"
        label="Groups"
        note={null}
      />
    );
    expect(html).not.toInclude('data-ui="share-meter"');
  });

  test('the note renders when given and not otherwise', () => {
    const note = "These don't add up to your net worth.";
    const html = renderToStaticMarkup(
      <ShareRows rows={OVERLAPPING} currency="USD" label="Groups" note={note} />
    );
    expect(html).toInclude('don&#x27;t add up');
    expect(
      renderToStaticMarkup(
        <ShareRows rows={OVERLAPPING} currency="USD" label="Groups" note={null} />
      )
    ).not.toInclude('add up');
  });

  test('with a resolver each addressable row is a link', () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/">
        <ShareRows
          rows={OVERLAPPING}
          currency="USD"
          label="Groups"
          note={null}
          itemHref={(row) => (row.key === 'b' ? null : `/holdings?group=${row.key}`)}
        />
      </StaticRouter>
    );
    expect(html).toInclude('href="/holdings?group=a"');
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe('DeltaPill', () => {
  test('a rise wears the gain tint, a fall the loss tint', () => {
    expect(renderToStaticMarkup(<DeltaPill value={1204} currency="USD" />)).toInclude('bg-gain/15');
    expect(renderToStaticMarkup(<DeltaPill value={-1204} currency="USD" />)).toInclude(
      'bg-loss/15'
    );
  });

  test('zero is neutral, not green', () => {
    expect(renderToStaticMarkup(<DeltaPill value={0} currency="USD" />)).toInclude('bg-neutral/15');
  });

  test('direction survives greyscale — the sign and arrow come from Numeric', () => {
    const html = renderToStaticMarkup(<DeltaPill value={-2.4} format="percent" decimals={1} />);
    expect(html).toInclude('↓');
    expect(html).toInclude('−2.4%');
  });

  test('an unknown value gets no tint, because "—" is not "unchanged"', () => {
    const html = renderToStaticMarkup(<DeltaPill value={null} currency="USD" />);
    expect(html).not.toInclude('bg-neutral/15');
    expect(html).toInclude('text-muted-foreground');
  });

  test('the period sits outside the tint, in muted ink', () => {
    const html = renderToStaticMarkup(<DeltaPill value={12} currency="USD" period="30d" />);
    expect(html).toInclude('vs 30d');
    expect(html.indexOf('bg-gain/15')).toBeLessThan(html.indexOf('vs 30d'));
  });
});

describe('StatTile', () => {
  test('label, then figure, then delta', () => {
    const html = renderToStaticMarkup(
      <StatTile
        label="Net worth"
        value={<Numeric value={100_000} currency="USD" />}
        delta={<DeltaPill value={1204} currency="USD" period="30d" />}
      />
    );
    expect(html.indexOf('Net worth')).toBeLessThan(html.indexOf('$100,000.00'));
    expect(html.indexOf('$100,000.00')).toBeLessThan(html.indexOf('vs 30d'));
  });

  test('hero emphasis is the display role; everything else is a title', () => {
    const value = <Numeric value={1} currency="USD" />;
    expect(renderToStaticMarkup(<StatTile label="a" value={value} emphasis="hero" />)).toInclude(
      'text-display'
    );
    expect(renderToStaticMarkup(<StatTile label="a" value={value} />)).toInclude('text-title');
  });

  test('the optional slots leave no empty wrappers behind', () => {
    const html = renderToStaticMarkup(
      <StatTile label="Cash" value={<Numeric value={500} currency="USD" />} />
    );
    expect(html).not.toInclude('mt-1');
    expect(html).not.toInclude('mt-2');
  });
});

describe('resolveSparklineTone', () => {
  test('reads the period end to end, not the last step', () => {
    // A month that ended higher is a gain even if the final day dipped.
    expect(resolveSparklineTone([100, 130, 120])).toBe('gain');
    expect(resolveSparklineTone([100, 70, 80])).toBe('loss');
  });

  test('flat is neutral, and so is a series with no shape', () => {
    expect(resolveSparklineTone([100, 130, 100])).toBe('neutral');
    expect(resolveSparklineTone([])).toBe('neutral');
    expect(resolveSparklineTone([100])).toBe('neutral');
  });
});
