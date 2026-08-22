import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import {
  BulkDeleteAction,
  bulkDeleteCommitLabel,
} from '@scani/ui/v3/components/data-view/BulkDeleteAction';
import i18n from 'i18next';
import {
  Children,
  createElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { selectedNames } from '../../../src/v3/components/entities/AccountsList';
import {
  holdingsDataViewConfig,
  selectedSymbols,
} from '../../../src/v3/components/holdings/holdingsConfig';
import type { AccountRow } from '../../../src/v3/lib/accounts';

// The nouns themselves are registered by `tests/i18n-preload.ts`, which
// mirrors what `src/i18n` forwards at boot (SC-257).
const HOLDINGS_NOUN = 'ui.dataView.noun.holdings';
const ACCOUNTS_NOUN = 'ui.dataView.noun.accounts';

/**
 * SC-63's blocker, pinned.
 *
 * `/holdings` → `Select` → a row checkbox raised a bar with `Assign groups` and
 * a solid red `Delete` eight pixels apart, and the red one deleted the row from
 * the database on the tap — no confirm, no undo. The header total dropped €73k
 * and `select count(*) from holdings where id=…` returned 0.
 *
 * There is no DOM in this suite, so "cannot execute without a confirm step" is
 * asserted two ways, and they close different holes:
 *
 * 1. **Structurally, on the real config.** Every click handler reachable in the
 *    resting bulk bar is fired, and nothing is deleted. That is precisely the
 *    regression — a bare `<Button onClick={() => onBulkDelete(...)}>` put back
 *    on the bar — and it fails loudly if anyone does.
 * 2. **On the frames.** The resting frame carries no commit button and no
 *    consequence sentence, so nothing on it can be the write; the open frame
 *    carries Cancel ahead of the commit.
 */

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

/** Every element in a tree of already-created elements. Does not descend into
 *  component elements — which is the point: it walks what the bar itself put
 *  on screen, not what a child chose to render behind its own state. */
function walk(node: ReactNode): ReactElement[] {
  const found: ReactElement[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    found.push(child);
    found.push(...walk((child.props as { children?: ReactNode }).children));
  }
  return found;
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
    },
    amount: '0.2841',
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

/** The app's own `t`, from the instance the preload above initialises — not a
 *  stub. A stub would let these tests agree with themselves; the real one makes
 *  them agree with `en.json`, so the English they assert on is the English the
 *  product ships (SC-201). */
const t = i18n.t.bind(i18n);

const HOLDINGS = [
  holding({ id: 'h1' }),
  holding({ id: 'h2', token: { ...holding().token, id: 't2', symbol: 'ETH', name: 'Ethereum' } }),
  holding({ id: 'h3', token: { ...holding().token, id: 't3', symbol: 'SOL', name: 'Solana' } }),
];

const PEEK = {
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
};

function bulkBar(onBulkDelete: (ids: string[]) => void) {
  const config = holdingsDataViewConfig({
    holdings: HOLDINGS,
    t,
    currency: '$',
    institutions: undefined,
    accounts: undefined,
    groups: undefined,
    defaultFilters: {},
    qualitySets: undefined,
    peek: PEEK,
    onAssignGroups: () => undefined,
    onBulkDelete,
    onAddData: () => undefined,
  });
  if (!config.renderBulkActions) throw new Error('the holdings bar has no bulk actions');
  return config.renderBulkActions(
    new Set(['h1', 'h2', 'h3']),
    () => undefined,
    () => undefined
  );
}

describe('the holdings bulk bar', () => {
  test('deletes nothing when every control on the resting bar is pressed', () => {
    const deleted: string[][] = [];
    const bar = bulkBar((ids) => deleted.push(ids));

    for (const element of walk(bar)) {
      const onClick = (element.props as { onClick?: () => void }).onClick;
      if (typeof onClick === 'function') onClick();
    }

    expect(deleted).toEqual([]);
  });

  test('the resting bar carries no commit and no consequence', () => {
    const markup = render(bulkBar(() => undefined));
    expect(markup).toContain('Delete');
    expect(markup).not.toContain('Delete 3 holdings');
    expect(markup).not.toContain('Cancel');
    expect(markup).not.toContain('cannot be undone');
  });
});

describe('BulkDeleteAction', () => {
  const BASE = {
    count: 3,
    nounKey: 'ui.dataView.noun.holdings',
    consequence: 'BTC, ETH and SOL are removed. This cannot be undone.',
    onConfirm: () => undefined,
  };

  test('rests as one trigger, with nothing on it that writes', () => {
    const markup = render(<BulkDeleteAction {...BASE} />);
    expect(markup).toContain('Delete');
    expect(markup).not.toContain('cannot be undone');
  });

  /**
   * The count belongs in the button, not only in the sentence: at 390px the
   * commit label is what gets read, and "Delete" reading the same on both taps
   * is what let the first tap also be the last one. The open frame is
   * `ConfirmAction`'s and its ordering is pinned there; what this file owns is
   * the label handed to it, so the label is a function it can call.
   */
  test('the commit names the count and is not labelled like the trigger', () => {
    expect(bulkDeleteCommitLabel(HOLDINGS_NOUN, 3)).toBe('Delete 3 holdings');
    expect(bulkDeleteCommitLabel(HOLDINGS_NOUN, 3)).not.toBe('Delete');
    expect(render(<BulkDeleteAction {...BASE} />)).not.toContain('Delete 3 holdings');
  });

  test('singularises, so a bar over one row does not offer to delete 1 holdings', () => {
    expect(bulkDeleteCommitLabel(HOLDINGS_NOUN, 1)).toBe('Delete 1 holding');
    expect(bulkDeleteCommitLabel(ACCOUNTS_NOUN, 1)).toBe('Delete 1 account');
  });
});

describe('naming the selection', () => {
  test('holdings name their symbols, in the order the rows are in', () => {
    expect(selectedSymbols(HOLDINGS, new Set(['h3', 'h1']))).toBe('BTC and SOL');
    expect(selectedSymbols(HOLDINGS, new Set(['h1', 'h2', 'h3']))).toBe('BTC, ETH and SOL');
    expect(selectedSymbols(HOLDINGS, new Set(['h2']))).toBe('ETH');
  });

  test('accounts name themselves', () => {
    const accounts = [
      { id: 'a1', name: 'Kraken Spot' },
      { id: 'a2', name: 'Revolut Main' },
    ] as AccountRow[];
    expect(selectedNames(accounts, new Set(['a1', 'a2']))).toBe('Kraken Spot and Revolut Main');
  });
});
