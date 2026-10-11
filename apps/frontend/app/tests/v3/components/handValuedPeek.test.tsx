import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type HoldingPeekContext,
  holdingPeekSpec,
} from '../../../src/v3/components/holdings/holdingPeek';
import { buildMoneyMove, buildValueUpdate } from '../../../src/v3/lib/hand-valued';

/**
 * SC-1596: a hand-valued holding is a figure in money the owner reads off a
 * statement. Its units are how Scani keeps flows apart from growth, and they
 * stay out of the owner's way.
 */

const t = i18n.t.bind(i18n);

const CONTEXT: HoldingPeekContext = {
  t,
  currency: 'USD',
  onEdit: () => undefined,
  onRecordMovement: () => undefined,
  onUpdateValue: () => undefined,
  onMoveMoney: () => undefined,
  onToggleActive: () => undefined,
  onMarkScam: () => undefined,
  onRefreshPrice: () => undefined,
  onRefreshBalance: () => undefined,
  refreshingPriceId: null,
  refreshingBalanceId: null,
  onEditPrice: () => undefined,
  onConfigureApy: () => undefined,
  onDelete: () => undefined,
};

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
    amount: '0.2841',
    value: 18_204.55,
    costBasis: 12_000,
    price: { value: '64072.18', timestamp: '2026-08-12T09:00:00.000Z', source: 'coingecko' },
    account: {
      id: 'a1',
      name: 'Spot',
      type: 'Exchange',
      typeCode: 'exchange',
      class: 'asset',
      institutionId: 'i1',
    },
    institution: { id: 'i1', name: 'Kraken', type: 'Exchange', typeCode: 'exchange' },
    groups: [],
    lastUpdated: '2026-08-12T09:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'manual',
    refreshable: false,
    deleteHides: false,
    ...overrides,
  };
}

const fund = () =>
  holding({
    token: {
      id: 't2',
      symbol: 'EDGECAP',
      name: 'Edge Capital',
      type: 'Other',
      typeCode: 'other',
      isScamProbability: 0,
    },
    amount: '80',
    value: 1064.8,
    costBasis: 800,
    price: { value: '13.31', timestamp: '2026-08-12T09:00:00.000Z', source: 'manual' },
  });

const render = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node));
const primaryLabels = (item: HoldingWithDetails) =>
  holdingPeekSpec(item, CONTEXT).primary.map((fact) => fact.label);
const actions = (item: HoldingWithDetails) => render(holdingPeekSpec(item, CONTEXT).actions);

describe('the peek of a hand-valued holding', () => {
  test('shows no units and no price per unit', () => {
    expect(primaryLabels(fund())).not.toContain('Amount');
    expect(primaryLabels(fund())).not.toContain('Price');
    // The control: a market-priced holding keeps both.
    expect(primaryLabels(holding())).toContain('Amount');
    expect(primaryLabels(holding())).toContain('Price');
  });

  test('offers "update value" and "money in / out" in place of a unit movement', () => {
    const offered = actions(fund());
    expect(offered).toInclude('Update value');
    expect(offered).toInclude('Money in / out');
    expect(offered).not.toInclude('Record a movement');

    const market = actions(holding());
    expect(market).not.toInclude('Update value');
    expect(market).toInclude('Record a movement');
  });

  test('names its cost basis as the money put in', () => {
    const facts = (holdingPeekSpec(fund(), CONTEXT).sections ?? []).flatMap((s) =>
      s.facts.map((f) => f.label)
    );
    expect(facts).toContain('Money put in');
    expect(facts).not.toContain('Cost basis');
  });

  test('leaves the unit-denominated activity and disposal lists out', () => {
    expect(holdingPeekSpec(fund(), CONTEXT).content).toBeFalsy();
    expect(holdingPeekSpec(holding(), CONTEXT).content).toBeTruthy();
  });
});

describe('what the two forms send', () => {
  test('a value is a positive amount in the currency, on the chosen day', () => {
    expect(buildValueUpdate('h1', 'USD', { value: '1350', date: '2026-09-30' })).toEqual({
      holdingId: 'h1',
      currencyCode: 'USD',
      value: '1350',
      occurredAt: expect.any(String),
    });
    expect(buildValueUpdate('h1', 'USD', { value: '0', date: '2026-09-30' })).toBeNull();
    expect(buildValueUpdate('h1', 'USD', { value: '', date: '2026-09-30' })).toBeNull();
    expect(buildValueUpdate('h1', 'USD', { value: '1350', date: '' })).toBeNull();
  });

  test('money in or out is a positive amount and a direction', () => {
    expect(
      buildMoneyMove('h1', 'USD', { direction: 'out', amount: '250', date: '2026-09-30' })
    ).toEqual({
      holdingId: 'h1',
      currencyCode: 'USD',
      direction: 'out',
      amount: '250',
      occurredAt: expect.any(String),
    });
    expect(
      buildMoneyMove('h1', 'USD', { direction: 'in', amount: '-5', date: '2026-09-30' })
    ).toBeNull();
  });
});
