import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';

/**
 * SC-219. `tokens.lookalike_of` was written by SC-197 and read by nothing —
 * nine rows carried a correct mark in production while every surface that
 * prints a symbol still showed `UЅDС` and `USDC` as the same picture.
 *
 * These tests exist because the failure mode is silent in both directions:
 * a column nobody reads looks exactly like a column with no rows in it, and
 * a badge that renders the wrong string looks exactly like one that renders
 * the right one until you compare it against the real symbol.
 *
 * `UЅDС` below is the production symbol — Cyrillic Ѕ (U+0405) and С (U+0421).
 * If an editor normalises it these tests fail, which is correct.
 */

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function holding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'USDC',
      name: 'USD Coin',
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
      lookalikeOf: null,
    },
    amount: '1000',
    value: 1000,
    costBasis: 1000,
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

/** The app's own `t`, from the instance the preload above initialises — not a
 *  stub. A stub would let these tests agree with themselves; the real one makes
 *  them agree with `en.json`, so the English they assert on is the English the
 *  product ships (SC-201). */
const t = i18n.t.bind(i18n);

const IMPOSTOR = holding({
  id: 'h2',
  token: {
    ...holding().token,
    id: 't2',
    symbol: 'UЅDС',
    name: 'USD Coin',
    lookalikeOf: 'USDC',
  },
});

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

describe('lookalike symbols are distinguishable on the holdings list', () => {
  /**
   * The assertion is the CONTRAST, not the presence of a badge. "Suspicious"
   * on a row captioned `UЅDС`, sitting beside a row captioned `USDC`, leaves
   * the two rows still looking alike — which is the state SC-197 set out to
   * fix and SC-219 found had never actually shipped.
   */
  test('the row says what the symbol imitates, not merely that something is wrong', () => {
    const config = configFor([IMPOSTOR]);
    const markup = render(config.renderRow(IMPOSTOR).label);

    expect(markup).toContain('Displays as USDC');
    // The raw symbol survives alongside it. Replacing the symbol with the
    // ASCII one it draws would be a lie in the opposite direction.
    expect(markup).toContain('UЅDС');
  });

  test('an ordinary symbol carries no badge at all', () => {
    const plain = holding();
    const markup = render(configFor([plain]).renderRow(plain).label);

    expect(markup).not.toContain('Displays as');
    expect(markup).toContain('USDC');
  });

  /**
   * A screen reader is where this attack is strongest: `UЅDС` and `USDC` are
   * not merely similar when spoken, they are INDISTINGUISHABLE. The badge is
   * the only thing separating them, so a visual-only badge would leave the
   * users most exposed with exactly what they had before.
   */
  test('the accessible name carries it too, because spoken aloud the two are identical', () => {
    const name = configFor([IMPOSTOR]).renderRow(IMPOSTOR).ariaLabel ?? '';
    expect(name).toContain('displays as USDC');
  });

  /**
   * The badge that must not be the one that disappears.
   *
   * `DataRow` wraps the label in `block truncate` — `overflow:hidden`,
   * `white-space:nowrap`. The first version of this feature put the lookalike
   * badge LAST in a flex row with no `min-w-0`, so at 390px on a row already
   * carrying `Inactive` and `No price` the row overflowed and was clipped from
   * the right, and the badge silently removed was the one saying "this is not
   * really USDC". The two that survived were the two that move with our own
   * pricing coverage.
   *
   * Order is the fix and order is testable without a browser. The lookalike
   * qualifies the symbol, so it sits against it — which is also what survives
   * truncation.
   */
  test('the lookalike badge comes before the badges that can crowd it out', () => {
    const crowded = holding({
      ...IMPOSTOR,
      isActive: false,
      value: null,
      token: { ...IMPOSTOR.token },
    });
    const markup = render(configFor([crowded]).renderRow(crowded).label);

    const lookalikeAt = markup.indexOf('Displays as USDC');
    const inactiveAt = markup.indexOf('Inactive');

    expect(lookalikeAt).toBeGreaterThan(-1);
    expect(inactiveAt).toBeGreaterThan(-1);
    expect(lookalikeAt).toBeLessThan(inactiveAt);
  });

  /**
   * Order alone is not enough: inside a `truncate` container a flex row with no
   * `min-w-0` overflows rather than shrinking, so everything past the width is
   * clipped regardless of order. The symbol must be the element that yields.
   *
   * Truncating the symbol and keeping the badge is the right way round — a
   * reader who sees `UЅD… · Displays as USDC` still learns the fact that
   * matters, where `UЅDС ·` with the badge cut off tells them nothing and looks
   * exactly like the real row.
   */
  test('the symbol yields space, not the badge', () => {
    const markup = render(configFor([IMPOSTOR]).renderRow(IMPOSTOR).label);

    // The flex row can shrink below its content...
    expect(markup).toMatch(/<span class="[^"]*min-w-0[^"]*">/);
    // ...the symbol is the part allowed to ellipsize...
    expect(markup).toMatch(/<span class="[^"]*truncate[^"]*">UЅDС<\/span>/);
    // ...and the badge itself is pinned against shrinking. Asserted on the
    // badge's own element rather than anywhere in the markup, because
    // `shrink-0` on some other node is not the same guarantee.
    expect(markup).toMatch(/shrink-0"[^>]*>Displays as USDC</);
  });

  /**
   * A spreadsheet renders both symbols identically, sorts them apart for no
   * visible reason, and matches neither against the other. Exporting the bare
   * symbol carries the impersonation out of the app into a file with no
   * tooltip to correct it.
   */
  test('the export disambiguates the impostor and leaves every other row alone', () => {
    const symbolColumn = configFor([IMPOSTOR]).columns.find((c) => c.key === 'symbol');
    const impostorCell = symbolColumn?.exportValue?.(IMPOSTOR);
    const plainCell = symbolColumn?.exportValue?.(holding());

    expect(impostorCell).toMatchObject({ kind: 'text', value: 'UЅDС (displays as USDC)' });
    // Every other row keeps the bare symbol — the exception is bought for the
    // impostors only, and a regression that widened it would show up here.
    expect(plainCell).toMatchObject({ kind: 'text', value: 'USDC' });
  });
});
