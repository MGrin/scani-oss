import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { HoldingsSummary } from '../../../src/v3/components/holdings/HoldingsSummary';

/**
 * The figure at the top of `/holdings`, and the sentence SC-63 made necessary.
 *
 * Excluding inactive holdings from the total is the fix; saying so is what
 * stops the fix from being a second unexplained number. A reader who adds the
 * visible rows up has to be able to find the difference on the same screen.
 */

function holding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
    },
    amount: '1',
    value: 100,
    costBasis: 80,
    account: {
      id: 'a1',
      name: 'Spot',
      type: 'Exchange',
      typeCode: 'exchange',
      institutionId: 'i1',
    },
    institution: { id: 'i1', name: 'Kraken', type: 'Exchange', typeCode: 'exchange' },
    groups: [],
    lastUpdated: '2026-08-12T09:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'import_wallet',
    ...overrides,
  };
}

function render(holdings: HoldingWithDetails[]): string {
  return renderToStaticMarkup(<HoldingsSummary holdings={holdings} currency="USD" />);
}

describe('HoldingsSummary', () => {
  test('totals only what counts, and names what it left out', () => {
    const html = render([
      holding({ id: 'h1', value: 525_728.45 }),
      holding({ id: 'h2', value: 73_782.57, isActive: false }),
    ]);
    expect(html).toInclude('525,728.45');
    expect(html).not.toInclude('599,511.02');
    expect(html).toInclude('Excludes 1 inactive holding');
    expect(html).toInclude('73,782.57');
  });

  test('says nothing when there is nothing to explain', () => {
    expect(render([holding({ value: 100 })])).not.toInclude('Excludes');
  });

  test('names the value it counts from a quote it would not call current', () => {
    const html = render([
      holding({ id: 'h1', value: 100 }),
      holding({ id: 'h2', value: 250.5, priceStale: true }),
    ]);
    // Both figures are in the total — a stale price still counts — so the
    // hero must be the sum and the sentence must say "Includes".
    expect(html).toInclude('350.50');
    expect(html).toInclude('Includes 1 holding');
    expect(html).toInclude('250.50');
  });

  test('the stale sentence comes before the excluded one', () => {
    // Opposite operations. Adjacent in the other order the larger claim about
    // counted value reads as a footnote to the smaller caveat about rows left
    // out, and a reader who has met one stops at the second.
    const html = render([
      holding({ id: 'h1', value: 100, priceStale: true }),
      holding({ id: 'h2', value: 20, isActive: false }),
    ]);
    expect(html.indexOf('Includes 1 holding')).toBeGreaterThan(-1);
    expect(html.indexOf('Excludes 1 inactive holding')).toBeGreaterThan(-1);
    expect(html.indexOf('Includes 1 holding')).toBeLessThan(
      html.indexOf('Excludes 1 inactive holding')
    );
  });

  test('says nothing about staleness when nothing was judged stale', () => {
    // An absent flag is "we could not date the price", not "it is fresh" —
    // neither earns a sentence, and inventing one for the first would be a
    // claim about a question nobody answered.
    expect(render([holding({ value: 100 })])).not.toInclude('Includes');
    expect(render([holding({ value: 100, priceStale: false })])).not.toInclude('Includes');
  });

  test('pluralises the sentence it is about to make the reader trust', () => {
    const html = render([
      holding({ id: 'h1', value: 10 }),
      holding({ id: 'h2', value: 20, isActive: false }),
      holding({ id: 'h3', value: 30, isActive: false }),
    ]);
    expect(html).toInclude('Excludes 2 inactive holdings');
  });
});
