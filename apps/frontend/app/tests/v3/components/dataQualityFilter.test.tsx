import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';
import type { DataQualitySets } from '../../../src/v3/lib/dataQuality';

/**
 * The link, followed (SC-293).
 *
 * `dataQuality.test.ts` proves the filter's predicate selects the right ids
 * and `dataQualityPanel.test.tsx` proves the panel emits the right URL. Neither
 * proves the two MEET — that `/holdings?quality=noCoverage` arrives at a list
 * narrowed to those holdings rather than at all of them. That join runs through
 * `V3DataView`, which seeds its filters from `location.search` for every key a
 * surface declared, and a filter that is declared but not seeded is exactly the
 * failure that would put a reader on an unnarrowed list under a chip claiming
 * twelve.
 *
 * Same harness as `answered-transfers.test.tsx`: `renderToStaticMarkup` has no
 * `window`, so `useIsDesktop()` resolves false and the card list renders;
 * `StaticRouter` is required because `V3DataView` reads the location.
 */

const t = i18n.t.bind(i18n);

function holding(id: string, symbol: string): HoldingWithDetails {
  return {
    id,
    token: {
      id: `token-${id}`,
      symbol,
      name: `${symbol} coin`,
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
      lookalikeOf: null,
    },
    amount: '1',
    value: 1,
    costBasis: 1,
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
  };
}

const HOLDINGS = [holding('h1', 'AAA'), holding('h2', 'BBB'), holding('h3', 'CCC')];

function renderList(search: string, qualitySets: DataQualitySets | undefined): string {
  const config = holdingsDataViewConfig({
    holdings: HOLDINGS,
    t,
    currency: '$',
    institutions: undefined,
    accounts: undefined,
    groups: undefined,
    defaultFilters: {},
    qualitySets,
    onBulkDelete: () => undefined,
    onAssignGroups: () => undefined,
    onAddData: () => undefined,
    peek: {
      t,
      currency: '$',
      onSetAmount: () => undefined,
      onRecordMovement: () => undefined,
      onToggleActive: () => undefined,
      onRefreshPrice: () => undefined,
      onRefreshBalance: () => undefined,
      refreshingPriceId: null,
      refreshingBalanceId: null,
      onEditPrice: () => undefined,
      onSetLabel: () => undefined,
      onConfigureApy: () => undefined,
      onRemoveApy: () => undefined,
      onDelete: () => undefined,
    },
  });
  return renderToStaticMarkup(
    <StaticRouter location={`/holdings${search}`}>
      <V3DataView config={config} getId={(item: HoldingWithDetails) => item.id} />
    </StaticRouter>
  );
}

/** Which of the three fixture symbols the list actually drew. */
function shown(html: string): string[] {
  return ['AAA', 'BBB', 'CCC'].filter((symbol) => html.includes(`>${symbol}<`));
}

describe('a data-quality link opens a narrowed holdings list', () => {
  test('without the parameter, nothing is narrowed', () => {
    // The control. Without it, an assertion that the filtered list holds two
    // rows would also pass against a filter that silently drops one.
    expect(shown(renderList('', { noCoverage: ['h1', 'h3'] }))).toEqual(['AAA', 'BBB', 'CCC']);
  });

  test('the URL alone narrows the list to the named holdings', () => {
    // No click, no state — the parameter is read on the first render, which is
    // what makes a filtered list a place that survives a reload, a Back and a
    // shared link.
    expect(shown(renderList('?quality=noCoverage', { noCoverage: ['h1', 'h3'] }))).toEqual([
      'AAA',
      'CCC',
    ]);
  });

  test('the row count matches the number the panel showed', () => {
    // The panel renders `flagged.noCoverage.length`. This is the other end of
    // that claim: follow the link and count what arrives.
    const ids = ['h2', 'h3'];
    expect(shown(renderList('?quality=noCoverage', { noCoverage: ids })).length).toBe(ids.length);
  });

  test('a kind with no ids narrows to nothing rather than to everything', () => {
    // The state a stale bookmark lands in. An empty list is honest; the whole
    // list under a chip naming a slice of it is not.
    expect(shown(renderList('?quality=noCoverage', { noCoverage: [] }))).toEqual([]);
  });
});
