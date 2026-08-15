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
    amount: 1,
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

  test('pluralises the sentence it is about to make the reader trust', () => {
    const html = render([
      holding({ id: 'h1', value: 10 }),
      holding({ id: 'h2', value: 20, isActive: false }),
      holding({ id: 'h3', value: 30, isActive: false }),
    ]);
    expect(html).toInclude('Excludes 2 inactive holdings');
  });
});
