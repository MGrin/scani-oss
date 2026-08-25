import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';

/**
 * SC-564. Four rows reading `RUB · Russian Ruble · Tinkoff` are four rows
 * nobody can tell apart, and a pot name is the only thing in the data that
 * tells them apart.
 *
 * The two surfaces render the same list, so both are asserted here. The card
 * view's `sublabel` carried the name from SC-330; the desktop TABLE did not,
 * and its own cell is where the four rows sit closest together — measured in a
 * browser against a seeded copy of the production account, where a named pot
 * was invisible in the table while being visible in the sheet one click away.
 * A name that appears on one surface and not the other is worse than no name.
 */

const t = i18n.t.bind(i18n);

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function holding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'RUB',
      name: 'Russian Ruble',
      type: 'Fiat Currency',
      typeCode: 'fiat',
      isScamProbability: 0,
      lookalikeOf: null,
    },
    amount: '89354.60',
    value: 1081.45,
    costBasis: null,
    account: {
      id: 'a1',
      name: 'Tinkoff',
      type: 'Checking Account',
      typeCode: 'checking',
      institutionId: 'i1',
    },
    institution: { id: 'i1', name: 'Tinkoff', type: 'Bank', typeCode: 'bank' },
    groups: [],
    lastUpdated: '2026-08-12T09:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'manual',
    ...overrides,
  };
}

function configFor(holdings: HoldingWithDetails[]) {
  return holdingsDataViewConfig({
    holdings,
    t,
    currency: '$',
    institutions: undefined,
    accounts: undefined,
    groups: undefined,
    onBulkDelete: () => undefined,
    defaultFilters: {},
    qualitySets: undefined,
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

/** The desktop table's identity cell — the `symbol` column, rendered. */
function identityCell(item: HoldingWithDetails): string {
  const column = configFor([item]).columns?.find((entry) => entry.key === 'symbol');
  if (!column) throw new Error('the holdings table no longer has a symbol column');
  return render(column.render(item));
}

/** The card view's row spec, which the phone and the narrow list use. */
function rowSublabel(item: HoldingWithDetails): ReactNode {
  return configFor([item]).renderRow(item).sublabel;
}

describe('the desktop table cell', () => {
  test('names the pot beside the token when the row carries one', () => {
    expect(identityCell(holding({ label: 'Текущий счёт' }))).toContain(
      'Russian Ruble · Текущий счёт'
    );
  });

  test('says only the token name when it does not', () => {
    // The control. Without it, joining an absent label would render
    // `Russian Ruble · ` — a separator pointing at nothing, on every ordinary
    // holding in the product.
    const cell = identityCell(holding());
    expect(cell).toContain('Russian Ruble');
    expect(cell).not.toContain('·');
  });
});

describe('the card view', () => {
  test('puts the pot between the token and the account', () => {
    // Between, not appended: the name distinguishes at the level of the
    // account's rows, so it reads outward from the most specific.
    expect(rowSublabel(holding({ label: 'Текущий счёт' }))).toBe(
      'Russian Ruble · Текущий счёт · Tinkoff'
    );
  });

  test('falls back to token and account with no pot', () => {
    expect(rowSublabel(holding())).toBe('Russian Ruble · Tinkoff');
  });
});

describe('both surfaces agree', () => {
  test('a named pot is visible in the table AND in the card row', () => {
    // The regression that was actually shipped and caught in a browser: the
    // card view had carried the name since SC-330 and the table had not, so a
    // user who named a pot saw no change on the surface they were looking at.
    const named = holding({ label: 'Депозит' });
    expect(identityCell(named)).toContain('Депозит');
    expect(String(rowSublabel(named))).toContain('Депозит');
  });
});
