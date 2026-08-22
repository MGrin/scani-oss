import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';

/**
 * SC-559. A holdings surface showed the base-currency value and nothing else,
 * and the unit count — where it appeared at all — was a BARE NUMBER.
 *
 * The two halves fail differently and both are asserted here:
 *
 * - the list row simply had no unit count, only the money;
 * - the peek's Amount fact had one and named its unit NOWHERE, so
 *   `0.00000142` sat under the label "Amount" and the reader recovered which
 *   token it counted from the sheet's title or not at all.
 *
 * The assertion is the SYMBOL, not the number. A bigger, bolder bare figure
 * answers nothing — what makes a number a quantity is the thing it counts, and
 * that is the half that was missing.
 *
 * `UЅDС` below is the production lookalike — Cyrillic Ѕ (U+0405) and С
 * (U+0421). If an editor normalises it these tests fail, which is correct.
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
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
      lookalikeOf: null,
    },
    amount: 0.2841,
    value: 18_204.55,
    costBasis: 12_000,
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
      onToggleActive: () => undefined,
      onRefreshPrice: () => undefined,
      onRefreshBalance: () => undefined,
      refreshingPriceId: null,
      refreshingBalanceId: null,
      onEditPrice: () => undefined,
      onConfigureApy: () => undefined,
      onRemoveApy: () => undefined,
      onDelete: () => undefined,
    },
  });
}

/** The peek's Amount fact, rendered. `HoldingAmountFact` is a component with
 *  state, so it is reached through the spec the way the sheet reaches it. */
function amountFact(item: HoldingWithDetails): string {
  const fact = configFor([item])
    .peek?.render(item)
    .primary.find((entry) => entry.label === 'Amount');
  if (!fact) throw new Error('the peek no longer has an Amount fact');
  return render(fact.value);
}

describe('the list row', () => {
  test('carries the unit count beside the money, with the symbol it counts', () => {
    const markup = render(configFor([holding()]).renderRow(holding()).value);

    // The money is still there and still first — this is an addition, not a
    // swap. Asserted by ORDER rather than by presence, because a row where the
    // quantity had displaced the value would contain both strings too.
    expect(markup.indexOf('18,204.55')).toBeGreaterThan(-1);
    expect(markup.indexOf('18,204.55')).toBeLessThan(markup.indexOf('0.2841'));
    expect(markup).toContain('BTC');
  });

  /**
   * Measured at 393px against a real 25-character symbol in this portfolio,
   * `GRAPHICS PROCESSING UNITS`: unbounded, the value zone took 198px and left
   * the identity zone 87px, so the account name — the thing the identity zone
   * exists to say — was unreadable on every row of that token. Bounded, the
   * same row measures 58px against 227px.
   *
   * This guard stays meaningful even if the amount ever moves or the symbol
   * gets shorter, because what it pins is WHICH of the two may give way. The
   * value zone is `whitespace-nowrap` and takes its width from its widest
   * child, so anything unbounded in it is spent out of identity at every
   * width, permanently. The figure is not allowed to be that thing — a
   * truncated figure is a different number — and the symbol is, because the
   * identity zone carries it in full, at row weight, with its badge, one line
   * to the left. Delete this and the row silently regains an unbounded child.
   */
  test('the symbol may ellipsize; the figure beside it may not', () => {
    const markup = render(configFor([holding()]).renderRow(holding()).value);

    // The symbol is the bounded, truncating element...
    expect(markup).toMatch(/<span class="max-w-\[6ch\] truncate">BTC<\/span>/);
    // ...and nothing in this zone truncates the figure. `Numeric` renders the
    // digits inside a `data-figure-fit` span, which is the shrink-to-fit
    // mechanism (SC-72) and deliberately not an ellipsis.
    expect(markup).toContain('data-figure-fit');
  });

  test('the money keeps the row type and the quantity takes the caption', () => {
    const markup = render(configFor([holding()]).renderRow(holding()).value);
    // The demotion is the whole design: two figures of equal weight in one
    // zone is worse than one, so the quantity is muted caption ink.
    expect(markup).toMatch(/text-caption[^"]*text-muted-foreground/);
  });

  /**
   * The row already badges its symbol in the identity zone, against the symbol
   * the badge qualifies. A second badge on the same row is a second claim, and
   * a reader who sees two asks which one is about which figure.
   */
  test('does not repeat the lookalike badge the identity zone already carries', () => {
    const impostor = holding({
      token: { ...holding().token, symbol: 'UЅDС', name: 'USD Coin', lookalikeOf: 'USDC' },
    });
    const value = render(configFor([impostor]).renderRow(impostor).value);
    const label = render(configFor([impostor]).renderRow(impostor).label);

    expect(label).toContain('Displays as USDC');
    expect(value).not.toContain('Displays as USDC');
  });
});

describe('the peek sheet', () => {
  test('names the unit the count is in, which it did not', () => {
    const markup = amountFact(holding());
    expect(markup).toContain('0.2841');
    expect(markup).toContain('BTC');
  });

  /**
   * The one place the row's rule is inverted, and deliberately.
   *
   * Printing a symbol beside the number is exactly what `holdingsConfig` warns
   * about: `UЅDС` and `USDC` are the same picture, so a bare one carries no
   * warning of its own. The list answers that with the badge in the identity
   * zone. The SHEET had no badge anywhere — its title is a bare symbol too —
   * so the unit introduced here brings the badge with it rather than adding a
   * second unmarked impersonation.
   */
  test('a lookalike symbol arrives with the badge that tells it apart', () => {
    const impostor = holding({
      token: { ...holding().token, symbol: 'UЅDС', name: 'USD Coin', lookalikeOf: 'USDC' },
    });
    expect(amountFact(impostor)).toContain('Displays as USDC');
  });

  test('an ordinary symbol carries no badge at all', () => {
    expect(amountFact(holding())).not.toContain('Displays as');
  });
});
