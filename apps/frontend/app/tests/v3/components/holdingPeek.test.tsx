import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { PeekBody } from '@scani/ui/v3/components/PeekSheet';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import i18n from 'i18next';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { trpc } from '../../../src/lib/trpc';
import {
  type HoldingPeekContext,
  holdingPeekSpec,
  holdingRowDelta,
} from '../../../src/v3/components/holdings/holdingPeek';

/**
 * What `HoldingDetailContent`'s twenty-odd fields become when they are ranked.
 *
 * The spec is asserted as data rather than as markup wherever it can be: the
 * ticket is about *which* facts are above the fold and which sections exist at
 * all, and both are answers this object already carries. Only `PeekBody` is
 * rendered — `PeekHeader` mounts the sparkline, which is a full chart query.
 *
 * The body needs a tRPC client as of SC-152: its `content` slot carries the
 * realized ledger, which asks for the lots behind the holding's gain. Nothing
 * is fetched — `renderToStaticMarkup` runs no effects, so the query stays
 * pending and the ledger renders itself away — but the context has to exist or
 * the hook throws. `RealizedLedger`'s own behaviour is tested through
 * `tests/v3/lib/realized-ledger.ts`, where it needs no DOM at all.
 */

/** The app's own `t`, from the instance the preload above initialises — not a
 *  stub. A stub would let these tests agree with themselves; the real one makes
 *  them agree with `en.json`, so the English they assert on is the English the
 *  product ships (SC-201). */
const t = i18n.t.bind(i18n);

const CONTEXT: HoldingPeekContext = {
  t,
  currency: 'USD',
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
};

/** The context the body's one query needs, and nothing more. `retry: false` and
 *  a URL nothing resolves, because a request would be a bug here: SSR runs no
 *  effects, so this exists to satisfy the hook, not to answer it. */
function TrpcContext({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

/** A bare `ReactNode` — an actions bundle, a delta — as markup. `Fragment` via
 *  `createElement` rather than `<>…</>`, which lints as a useless fragment even
 *  though `renderToStaticMarkup` will not take a node without one. */
function renderNode(node: ReactNode): string {
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

const sectionTitles = (item: HoldingWithDetails) =>
  (holdingPeekSpec(item, CONTEXT).sections ?? []).map((section) => section.title);

const factLabels = (item: HoldingWithDetails, title: string) =>
  (holdingPeekSpec(item, CONTEXT).sections ?? [])
    .find((section) => section.title === title)
    ?.facts.map((fact) => fact.label) ?? [];

describe('the four facts above the fold', () => {
  test('are what the position is, not everything known about it', () => {
    const spec = holdingPeekSpec(holding(), CONTEXT);
    expect(spec.primary.map((fact) => fact.label)).toEqual(['Amount', 'Price', 'Account', 'Type']);
  });

  test('the identity names the token and where it is held', () => {
    const spec = holdingPeekSpec(holding(), CONTEXT);
    expect(spec.title).toBe('BTC');
    expect(spec.subtitle).toBe('Bitcoin · Kraken');
  });
});

describe('sections', () => {
  test('performance only exists when there is a cost basis to measure against', () => {
    expect(sectionTitles(holding())).toContain('Performance');
    expect(sectionTitles(holding({ costBasis: null }))).not.toContain('Performance');
    // Unpriceable: v2 would render this as a 100% loss.
    expect(sectionTitles(holding({ value: null }))).not.toContain('Performance');
  });

  test('interest follows the account type', () => {
    expect(sectionTitles(holding())).not.toContain('Interest');
    expect(
      sectionTitles(holding({ account: { ...holding().account, typeCode: 'savings' } }))
    ).toContain('Interest');
  });

  test('an existing rate offers its schedule; an absent one offers only the way in', () => {
    const savings = { ...holding().account, typeCode: 'savings' };
    expect(factLabels(holding({ account: savings }), 'Interest')).toEqual(['APY']);
    expect(
      factLabels(
        holding({
          account: savings,
          apyConfig: {
            id: 'c1',
            annualRatePct: '4.5',
            payoutFrequency: 'monthly',
            payoutDayOfWeek: null,
            payoutDayOfMonth: 1,
            payoutMonth: null,
            lastPayoutAt: '2026-08-01T00:00:00.000Z',
            isActive: true,
          },
        }),
        'Interest'
      )
    ).toEqual(['APY', 'Payout', 'Last payout']);
  });

  test('groups are always a section, so "none" is answered rather than missing', () => {
    // SC-70 made this unconditional. "Which groups is this in?" is asked of the
    // holding, and a section that disappears when the answer is nothing cannot
    // be told apart from one that failed to load.
    expect(sectionTitles(holding())).toContain('Groups');
    expect(
      sectionTitles(holding({ groups: [{ id: 'g1', name: 'Long term', color: '#22c55e' }] }))
    ).toContain('Groups');
  });

  test('an incomplete history is stated, not left in a hover tooltip', () => {
    expect(factLabels(holding(), 'Record')).not.toContain('History');
    expect(factLabels(holding({ dataIntegrity: { incompleteHistory: true } }), 'Record')).toContain(
      'History'
    );
  });
});

describe('actions', () => {
  test('a manual holding is not offered a sync it cannot do', () => {
    const synced = renderNode(holdingPeekSpec(holding(), CONTEXT).actions);
    expect(synced).toInclude('Sync balance');

    const manual = renderNode(holdingPeekSpec(holding({ source: 'manual' }), CONTEXT).actions);
    expect(manual).not.toInclude('Sync balance');
    expect(manual).toInclude('Refresh price');
  });

  test('a refresh in flight names itself and cannot be pressed twice', () => {
    const html = renderNode(
      holdingPeekSpec(holding(), { ...CONTEXT, refreshingPriceId: 'h1' }).actions
    );
    expect(html).toInclude('Refreshing…');
    expect(html).toInclude('disabled');
  });

  test('a job on another holding leaves this one pressable', () => {
    const html = renderNode(
      holdingPeekSpec(holding(), { ...CONTEXT, refreshingPriceId: 'other' }).actions
    );
    expect(html).toInclude('Refresh price');
  });

  /**
   * SC-63. Deactivating used to be a filled primary pill in the fact list
   * whose only claim to being a control was an `aria-label`, and it wrote on
   * the first tap. It is a labelled button in the action row now, next to the
   * two that already behaved, and it asks first.
   */
  test('changing the status is a labelled button in the row, alongside the rest', () => {
    const active = renderNode(holdingPeekSpec(holding(), CONTEXT).actions);
    expect(active).toInclude('Deactivate');

    const inactive = renderNode(holdingPeekSpec(holding({ isActive: false }), CONTEXT).actions);
    expect(inactive).toInclude('Activate');
    expect(inactive).not.toInclude('Deactivate');
  });

  test('the resting status button says nothing about what it would do', () => {
    const html = renderNode(holdingPeekSpec(holding(), CONTEXT).actions);
    expect(html).not.toInclude('stops counting');
    expect(html).not.toInclude('Cancel');
  });

  /** The tap-target floor: `size="sm"` pins `min-h-[36px]` as a utility, which
   *  beats the `pointer: coarse` rule v3-tokens re-applies in the base layer. */
  test('no action in the row opts out of the touch target floor', () => {
    const html = renderNode(holdingPeekSpec(holding(), CONTEXT).actions);
    expect(html).not.toInclude('min-h-[36px]');
  });
});

describe('the Status fact', () => {
  function statusFact(item: HoldingWithDetails) {
    return (holdingPeekSpec(item, CONTEXT).sections ?? [])
      .find((section) => section.title === 'Record')
      ?.facts.find((fact) => fact.label === 'Status');
  }

  test('is a readout and cannot be pressed', () => {
    const html = renderNode(statusFact(holding())?.value);
    expect(html).toInclude('Active');
    // The whole M-9 defect in one assertion: a status that is a `<button>` is
    // a destructive write dressed as a badge.
    expect(html).not.toInclude('<button');
    expect(html).not.toInclude('aria-label');
  });

  test('still says which state the holding is in', () => {
    expect(renderNode(statusFact(holding({ isActive: false }))?.value)).toInclude('Inactive');
  });
});

describe('what the body actually renders', () => {
  test('carries the facts, the figures and the group badges', () => {
    // `StaticRouter`, because the group badges are `<Link>`s as of SC-70 —
    // membership is edited on the group's own page and this is the way in.
    // Not `MemoryRouter`: it floods SSR with useLayoutEffect warnings.
    const html = renderToStaticMarkup(
      <StaticRouter location="/holdings/h1">
        <TrpcContext>
          <PeekBody
            spec={holdingPeekSpec(
              holding({ groups: [{ id: 'g1', name: 'Long term', color: '#22c55e' }] }),
              CONTEXT
            )}
          />
        </TrpcContext>
      </StaticRouter>
    );
    expect(html).toInclude('Amount');
    expect(html).toInclude('0.2841');
    expect(html).toInclude('64,072.18');
    expect(html).toInclude('Cost basis');
    expect(html).toInclude('12,000.00');
    expect(html).toInclude('Long term');
    // The price's age, at full-strength muted ink rather than v2's `/70`.
    expect(html).toInclude('coingecko');
  });
});

describe('holdingRowDelta', () => {
  test('is the P/L percentage, signed', () => {
    const html = renderNode(holdingRowDelta(holding({ value: 150, costBasis: 100 })));
    expect(html).toInclude('+');
    expect(html).toInclude('50.0%');
  });

  test('is nothing at all when there is no basis for it', () => {
    expect(holdingRowDelta(holding({ costBasis: null }))).toBeUndefined();
  });
});

/**
 * SC-564 — the pot name, and when it is worth asking for.
 *
 * The fact itself is SC-330's. What is new is that it appears on rows that
 * have no name YET, and that it is editable: until this, `label` could only be
 * set when the holding was created, so the rows the fact was designed for —
 * four RUB rows in one Tinkoff account — could never acquire one and it never
 * rendered in production at all.
 */
describe('the pot name', () => {
  const primaryLabels = (item: HoldingWithDetails, ctx: HoldingPeekContext = CONTEXT) =>
    holdingPeekSpec(item, ctx).primary.map((fact) => fact.label);

  test('is offered on a row that shares its account and token with a sibling', () => {
    // The reader is looking at one of several identical-looking rows. This is
    // the case the whole ticket is about, and before SC-564 it was the one
    // case that got no field.
    const contested = { ...CONTEXT, contestedHoldingIds: new Set(['h1']) };
    expect(primaryLabels(holding(), contested)).toEqual([
      'Amount',
      'Price',
      'Account',
      'Pot',
      'Type',
    ]);
  });

  test('is offered on a row that already carries one, contested or not', () => {
    expect(primaryLabels(holding({ label: 'Savings' }))).toContain('Pot');
  });

  test('is NOT offered on an unnamed row that is the only one for its token', () => {
    // The control, and the reason the fact is conditional at all: a "Pot" row
    // on every holding is a field that says nothing, and this assertion is
    // what stops the condition being quietly widened to `true`. If it ever
    // goes red, four of the five facts above the fold on every ordinary
    // holding are now paying for a question nobody has.
    expect(primaryLabels(holding())).not.toContain('Pot');
    expect(primaryLabels(holding())).toEqual(['Amount', 'Price', 'Account', 'Type']);
  });

  test('renders the name it carries, and an invitation when it has none', () => {
    const named = holdingPeekSpec(holding({ label: 'Savings' }), CONTEXT).primary.find(
      (fact) => fact.label === 'Pot'
    );
    expect(renderNode(named?.value)).toContain('Savings');

    const contested = { ...CONTEXT, contestedHoldingIds: new Set(['h1']) };
    const unnamed = holdingPeekSpec(holding(), contested).primary.find(
      (fact) => fact.label === 'Pot'
    );
    // Not an em-dash. A row that says "Pot: —" tells the reader nothing about
    // what the control beside it would do.
    expect(renderNode(unnamed?.value)).toContain('Not named');
  });
});
