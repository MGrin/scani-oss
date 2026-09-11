import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';
import { stalePricedInTotal } from '../../../src/v3/lib/holdings';

/**
 * Stale-priced holdings, findable from the list (SC-981).
 *
 * SC-956 put "Includes 1 holding … priced from a stale quote" under the figure
 * and nowhere else, so the reader was told how many and could not reach which.
 * Two halves close it and both are asserted here: the row's figure carries a
 * mark, and `?price=stale` narrows the list to exactly the rows that count.
 *
 * Same harness as `dataQualityFilter.test.tsx`: `renderToStaticMarkup` has no
 * `window`, so the card list renders, and `StaticRouter` feeds the location
 * `V3DataView` seeds its filters from.
 */

const t = i18n.t.bind(i18n);

function holding(
  id: string,
  symbol: string,
  overrides: Partial<HoldingWithDetails> = {}
): HoldingWithDetails {
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
    price: { value: '1', timestamp: '2026-08-01T09:00:00.000Z', source: 'coingecko' },
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

const STALE = holding('h1', 'AAA', { priceStale: true });
const FRESH = holding('h2', 'BBB', { priceStale: false });
const STALE_INACTIVE = holding('h3', 'CCC', { priceStale: true, isActive: false });
const UNDATED = holding('h4', 'DDD');
const HOLDINGS = [STALE, FRESH, STALE_INACTIVE, UNDATED];

function configFor(holdings: HoldingWithDetails[]) {
  return holdingsDataViewConfig({
    holdings,
    t,
    currency: '$',
    institutions: undefined,
    accounts: undefined,
    groups: undefined,
    defaultFilters: {},
    qualitySets: undefined,
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
}

function renderList(search: string, holdings = HOLDINGS): string {
  return renderToStaticMarkup(
    <StaticRouter location={`/holdings${search}`}>
      <V3DataView config={configFor(holdings)} getId={(item: HoldingWithDetails) => item.id} />
    </StaticRouter>
  );
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function shown(html: string): string[] {
  return ['AAA', 'BBB', 'CCC', 'DDD'].filter((symbol) => html.includes(`>${symbol}<`));
}

const STALE_LABEL = /Stale quote, /;

describe('the stale-price filter', () => {
  test('without the parameter, nothing is narrowed', () => {
    // The control for every narrowing assertion below.
    expect(shown(renderList(''))).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });

  test('?price=stale narrows to the stale rows the total counts', () => {
    // Not CCC: it is stale but inactive, so the caption does not count it,
    // and the list the caption opens must not hold it either.
    expect(shown(renderList('?price=stale'))).toEqual(['AAA']);
  });

  test("the list's length is the caption's count", () => {
    const rows = [
      STALE,
      holding('h5', 'EEE', { priceStale: true }),
      FRESH,
      STALE_INACTIVE,
      UNDATED,
    ];
    const listed = ['AAA', 'EEE', 'BBB', 'CCC', 'DDD'].filter((symbol) =>
      renderList('?price=stale', rows).includes(`>${symbol}<`)
    );
    expect(listed.length).toBe(stalePricedInTotal(rows).count);
    expect(listed.length).toBe(2);
  });

  test('is offered in Refine only when a row would match', () => {
    const offered = (rows: HoldingWithDetails[]) =>
      configFor(rows).filterDefs?.find((def) => def.key === 'price')?.options ?? [];
    expect(offered(HOLDINGS).map((option) => option.value)).toEqual(['stale']);
    expect(offered([FRESH, STALE_INACTIVE, UNDATED])).toEqual([]);
  });
});

describe('the stale mark on the row', () => {
  const config = configFor(HOLDINGS);

  test('marks the figure of a stale row, saying how old the quote is', () => {
    const markup = render(config.renderRow(STALE).value);
    expect(markup).toMatch(STALE_LABEL);
    expect(markup).toInclude('2026');
  });

  test('leaves a fresh row unmarked', () => {
    // The control. A mark on every row is no mark.
    expect(render(config.renderRow(FRESH).value)).not.toMatch(STALE_LABEL);
  });

  test('leaves an undated row unmarked', () => {
    expect(render(config.renderRow(UNDATED).value)).not.toMatch(STALE_LABEL);
  });

  test('is never in the badge slot', () => {
    // The 390px survival order in `holdingsConfig` is lookalike, inactive,
    // no-price — and this mark is none of them. A fresh, active, priced row
    // renders its label as the bare symbol; a stale one must too.
    expect(config.renderRow(STALE).label).toBe('AAA');
  });

  test('is spoken with the row', () => {
    // The row is one control with an aria-label, so what is drawn inside it
    // is not what a screen reader says. The mark has to be in the name.
    expect(config.renderRow(STALE).ariaLabel).toMatch(STALE_LABEL);
    expect(config.renderRow(FRESH).ariaLabel).not.toMatch(STALE_LABEL);
  });

  test('marks the desktop price cell, and only on a stale row', () => {
    const price = config.columns?.find((column) => column.key === 'price');
    expect(render(price?.render(STALE))).toMatch(STALE_LABEL);
    expect(render(price?.render(FRESH))).not.toMatch(STALE_LABEL);
  });
});
