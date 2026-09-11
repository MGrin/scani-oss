import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
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

function render(holdings: HoldingWithDetails[], location = '/holdings'): string {
  return renderToStaticMarkup(
    <StaticRouter location={location}>
      <HoldingsSummary holdings={holdings} currency="USD" />
    </StaticRouter>
  );
}

/** The `href` of the one link in the markup, or null. */
function linkHref(html: string): string | null {
  return /<a [^>]*href="([^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') ?? null;
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

  /**
   * The count, made reachable (SC-981). It links to the stale-price filter
   * layered on whatever is already applied, because the count is over the rows
   * on screen and the list it opens has to be those rows' stale subset.
   */
  describe('the stale sentence links to exactly the rows it counts', () => {
    const rows = [
      holding({ id: 'h1', value: 100 }),
      holding({ id: 'h2', value: 250.5, priceStale: true }),
    ];

    test('to the stale-price filter', () => {
      expect(linkHref(render(rows))).toBe('/holdings?price=stale');
    });

    test('keeping the filters already applied', () => {
      const href = linkHref(render(rows, '/holdings?account=a1'));
      const params = new URLSearchParams(href?.split('?')[1]);
      expect(params.get('account')).toBe('a1');
      expect(params.get('price')).toBe('stale');
    });

    test('and is plain text once the list already is that set', () => {
      // A link to the page you are on. The sentence still says what it says.
      const html = render(rows, '/holdings?price=stale');
      expect(html).toInclude('Includes 1 holding');
      expect(linkHref(html)).toBeNull();
    });

    test('nothing else in the summary is a link', () => {
      // The control: the excluded caption has nowhere to send the reader.
      expect(
        linkHref(render([holding({ value: 10 }), holding({ id: 'h2', isActive: false })]))
      ).toBeNull();
    });
  });

  test('pluralises the sentence it is about to make the reader trust', () => {
    const html = render([
      holding({ id: 'h1', value: 10 }),
      holding({ id: 'h2', value: 20, isActive: false }),
      holding({ id: 'h3', value: 30, isActive: false }),
    ]);
    expect(html).toInclude('Excludes 2 inactive holdings');
  });

  /**
   * The degenerate case (SC-1122). Filtered to an account whose holdings are
   * every one inactive, the caption stops explaining a difference and names
   * the whole page, under a hero reading zero. The number the reader came for
   * is on screen twice — in the caption and on the row — and the largest
   * element on the page says they have nothing.
   *
   * The control on every one of these is the MIXED case directly below. mgrin
   * called that behaviour correct in as many words, so a fix that also moved
   * it would have overreached and undone SC-388.
   */
  describe('when every listed holding is inactive', () => {
    test('headlines what they are worth instead of zero', () => {
      const html = render([
        holding({ id: 'h1', value: 1200.5, isActive: false }),
        holding({ id: 'h2', value: 300.25, isActive: false }),
      ]);
      expect(html).toInclude('1,500.75');
      expect(html).not.toInclude('0.00');
    });

    test('marks the figure at the tile label, not only underneath it', () => {
      // A bare total under "Value" would read as live portfolio value, which
      // is the SC-388 defect running the other way and quieter than the zero
      // it replaces.
      const html = render([holding({ value: 1200.5, isActive: false })]);
      expect(html).toInclude('Inactive value');
      expect(html).not.toInclude('>Value<');
    });

    test('says the figure is in no portfolio total', () => {
      const html = render([holding({ value: 1200.5, isActive: false })]);
      expect(html).toInclude('none of this is in your portfolio total');
    });

    test('drops the excludes caption, which would now contradict the headline', () => {
      // "Excludes 1 inactive holding worth $1,200.50" directly under a hero
      // reading $1,200.50 is the same number claimed as both counted and not.
      const html = render([holding({ value: 1200.5, isActive: false })]);
      expect(html).not.toInclude('Excludes');
    });
  });

  test('a mixed list is untouched — one active row is enough', () => {
    // The boundary, asserted rather than promised. Same data as the
    // all-inactive case plus a single active row.
    const html = render([
      holding({ id: 'h1', value: 40 }),
      holding({ id: 'h2', value: 1200.5, isActive: false }),
    ]);
    expect(html).toInclude('Excludes 1 inactive holding');
    expect(html).not.toInclude('Inactive value');
    expect(html).not.toInclude('none of this is in your portfolio total');
  });

  test('an empty list keeps the ordinary headline', () => {
    // No rows to be inactive. "Every one of no holdings is inactive" is
    // vacuously true and would put an inactive-value label on nothing.
    const html = render([]);
    expect(html).not.toInclude('Inactive value');
    expect(html).toInclude('0.00');
  });

  test('an active but unpriceable list keeps the ordinary headline', () => {
    // Also totals zero, and that zero is correct: nothing is excluded, we
    // just do not know what it is worth. Keying the new case on the FIGURE
    // rather than on the rows would capture this one too and claim the
    // holding is inactive when it is not.
    const html = render([holding({ value: null })]);
    expect(html).not.toInclude('Inactive value');
    expect(html).not.toInclude('Excludes');
  });
});
