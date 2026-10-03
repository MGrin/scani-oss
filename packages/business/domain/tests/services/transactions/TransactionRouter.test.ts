process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext, TransactionEvent } from '@scani/providers/core/types';
import { Container } from 'typedi';
import {
  TransactionRouter,
  type TransactionRouterRequest,
} from '../../../src/services/transactions/TransactionRouter';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

function makeBaseCurrency(): Token {
  return {
    id: 'usd-token',
    symbol: 'USD',
    name: 'US Dollar',
    typeId: 'fiat-type-id',
    decimals: 2,
    decimalsSource: 'chain',
    iconUrl: null,
    lastPricingAttemptAt: null,
    lookalikeOf: null,
    createdByUserId: null,
    unpriceableUntil: null,
    providerMetadata: {},
    isScamProbability: 0,
    scamScoreVersion: null,
    scamScoreSource: 'heuristic',
    isActive: true,
    marketSegment: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

interface SetupOpts {
  events: TransactionEvent[];
  /** When provided, the registry is seeded with a stub
      `TransactionsProvider` for this institutionCode. */
  withProviderForInstitution?: string;
  /** Mirrors a provider that substitutes its own look-back when handed no
      `since` (Bybit, Bitget, OKX). */
  transactionHistoryHorizonMs?: number;
  /** Reasons the stub provider retracts with during the walk (SC-395).
      Mirrors a paginator that set out for the whole ledger and came back
      knowing it had not reached the end. */
  retractWith?: readonly string[];
  /** How far back the stub says its source reaches, stated ON the retraction
      (SC-900). One entry per `retractWith` reason, `undefined` for a provider
      that retracts without being able to name a boundary. */
  retractBounds?: ReadonlyArray<Date | undefined>;
  /** Reasons the stub provider reports WITHOUT retracting (SC-428) — a walk
      that annotates rather than produces, such as bitstamp's txid lookup. */
  noteWith?: readonly string[];
}

function setup(opts: SetupOpts): {
  router: TransactionRouter;
  request: TransactionRouterRequest;
} {
  const provider: TransactionsProvider = {
    providerKey: 'stub',
    capabilities: ['transactions'],
    canFetchTransactions: (institutionCode: string) =>
      institutionCode === opts.withProviderForInstitution,
    fetchTransactions: async (ctx) => {
      (opts.retractWith ?? []).forEach((reason, i) => {
        const at = opts.retractBounds?.[i];
        ctx.retractHistoryClaim?.(reason, at ? { historyStartsAt: at } : undefined);
      });
      for (const reason of opts.noteWith ?? []) ctx.noteWarning?.(reason);
      return opts.events;
    },
    transactionHistoryHorizonMs: opts.transactionHistoryHorizonMs,
  };

  const registry = new ProviderRegistry();
  if (opts.withProviderForInstitution) registry.register(provider);
  Container.set(ProviderRegistry, registry);

  const router = new TransactionRouter();
  Container.set(TransactionRouter, router);

  const request: TransactionRouterRequest = {
    userId: 'u1',
    accountId: 'a1',
    institutionId: 'inst-1',
    institutionCode: 'kraken',
    source: 'kraken-api',
    baseCurrency: makeBaseCurrency(),
    resolveCredentials: (async () => ({
      apiKey: 'x',
      apiSecret: 'y',
    })) as ProviderContext['resolveCredentials'],
  };

  return { router, request };
}

describe('TransactionRouter.hasProviderFor', () => {
  test('returns false when no provider matches the institutionCode', () => {
    const { router } = setup({ events: [] });
    expect(router.hasProviderFor('kraken')).toBe(false);
  });

  test('returns true when the registry has a provider for the code', () => {
    const { router } = setup({ events: [], withProviderForInstitution: 'kraken' });
    expect(router.hasProviderFor('kraken')).toBe(true);
  });
});

describe('TransactionRouter.run', () => {
  test('throws when no provider is registered for the institutionCode', async () => {
    const { router, request } = setup({ events: [] });
    await expect(router.run(request)).rejects.toThrow(/no provider registered/);
  });

  test('returns an empty result when the provider returns no events', async () => {
    const { router, request } = setup({ events: [], withProviderForInstitution: 'kraken' });
    const result = await router.run(request);
    expect(result.events).toHaveLength(0);
    // No `since` provided in request → claims complete history.
    expect(result.hasCompleteTxHistory).toBe(true);
  });

  test('reports incomplete history when called with a since cutoff', async () => {
    const { router, request } = setup({ events: [], withProviderForInstitution: 'kraken' });
    const result = await router.run({ ...request, since: new Date('2024-01-01') });
    expect(result.hasCompleteTxHistory).toBe(false);
  });

  // SC-166. `!since` says the caller asked for the whole ledger; it says
  // nothing about whether the provider can deliver one. Bybit substitutes a
  // 30-day look-back for a missing `since`, so the old derivation marked
  // coverage complete over a month of history — and SC-149 made that flag
  // load-bearing for cost basis, so the wrong `true` reaches a number on a
  // screen rather than sitting in an unread column.
  test('refuses to claim complete history from a provider with a look-back horizon', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      transactionHistoryHorizonMs: 30 * 24 * 60 * 60 * 1000,
    });
    const result = await router.run(request);
    expect(result.hasCompleteTxHistory).toBe(false);
  });

  test('the horizon suppresses the claim on a run that returned events too', async () => {
    // A bounded provider that actually returns transactions is the case that
    // reaches the ledger, so the claim is checked on one, not only on an empty run.
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      transactionHistoryHorizonMs: 7 * 24 * 60 * 60 * 1000,
      events: [
        {
          externalId: 'evt-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1' },
        } as TransactionEvent,
      ],
    });
    const result = await router.run(request);
    expect(result.events).toHaveLength(1);
    expect(result.horizonMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(result.hasCompleteTxHistory).toBe(false);
  });

  /**
   * SC-428. The `false` above is right and nothing said why: a Binance import
   * wrote `has_complete_tx_history = false` with an empty `warnings` list, and
   * the cost-basis chip read "partial" with no stated cause — while a page cap
   * (SC-426) and a self-contradicting ledger (SC-395) both explain themselves.
   */
  test('a since-less run through a horizon provider says how far back it reached', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      transactionHistoryHorizonMs: 5 * 365 * 24 * 60 * 60 * 1000,
    });
    const result = await router.run(request);
    expect(result.warnings).toEqual([
      'stub: a run with no start date reaches 5 years back and no further — anything older than that was never fetched',
    ]);
    // A notice, not evidence. `historyRetractions` is what entitles an
    // incremental run to write a `false` it did not inherit from having asked
    // for a window, and a standing horizon must not do that.
    expect(result.historyRetractions).toEqual([]);
  });

  test('it says it on a run that returned events, not only on an empty one', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      transactionHistoryHorizonMs: 30 * 24 * 60 * 60 * 1000,
      events: [
        {
          externalId: 'evt-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1' },
        } as TransactionEvent,
      ],
    });
    const result = await router.run(request);
    expect(result.warnings[0]).toContain('reaches 1 month back and no further');
  });

  /**
   * The both-directions guard the other two got, and the reason this is not
   * simply "warn whenever the flag is false". A `since`-bounded run reaches
   * the end of its window every time; its `false` is SILENCE about the whole
   * ledger, not evidence about it (SC-360). A window is the caller's choice
   * and telling the reader their history is capped would be a false alarm
   * every night the incremental runs.
   */
  test('a since-bounded run through the same provider says nothing', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      transactionHistoryHorizonMs: 30 * 24 * 60 * 60 * 1000,
    });
    const result = await router.run({ ...request, since: new Date('2024-01-01') });
    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test('a provider with no horizon says nothing either', async () => {
    const { router, request } = setup({ events: [], withProviderForInstitution: 'kraken' });
    const result = await router.run(request);
    expect(result.warnings).toEqual([]);
  });

  test("the horizon reads first and the walk's own verdict after it", async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      transactionHistoryHorizonMs: 7 * 24 * 60 * 60 * 1000,
      retractWith: ['stub: the paginator did not confirm it reached the end'],
    });
    const result = await router.run(request);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('reaches 7 days back');
    expect(result.warnings[1]).toContain('did not confirm');
  });

  /**
   * The non-retracting half of the channel (SC-428). bitstamp's
   * `/crypto-transactions/` walk hangs an on-chain txid onto events the ledger
   * walk already produced; exhausting its own page cap costs an annotation and
   * no rows, so it must reach the reader without moving the flag that feeds
   * cost basis.
   */
  test('a provider notice reaches warnings and leaves the completeness claim alone', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      noteWith: ['stub: the txid lookup capped — some deposits carry no on-chain id'],
    });
    const result = await router.run(request);
    expect(result.warnings).toEqual([
      'stub: the txid lookup capped — some deposits carry no on-chain id',
    ]);
    expect(result.historyRetractions).toEqual([]);
    expect(result.hasCompleteTxHistory).toBe(true);
  });

  test("returns the provider's events as they came, and the instant it asked", async () => {
    const events = [
      {
        externalId: 'b',
        occurredAt: new Date('2024-06-01T00:00:00Z'),
        kind: 'deposit',
        primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '2' },
      },
      {
        externalId: 'a',
        occurredAt: new Date('2024-05-01T00:00:00Z'),
        kind: 'deposit',
        primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '1' },
      },
    ] as TransactionEvent[];
    const { router, request } = setup({ withProviderForInstitution: 'kraken', events });
    const before = new Date();
    const result = await router.run(request);
    expect(result.events).toEqual(events);
    expect(result.fetchedAt >= before && result.fetchedAt <= new Date()).toBe(true);
    expect(result.horizonMs).toBeUndefined();
  });
});

/**
 * A provider that knows its walk was partial can say so (SC-395).
 *
 * `claimsCompleteHistory` was the only voice: `!since` and an undeclared
 * horizon between them decided the flag, and nothing the walk itself
 * observed could move it. Kraken's paginator computed
 * `hasCompleteTxHistory` over every page it had just read — 2 breaks in
 * Kraken's own running balance, 40 legs of two-legged operations whose
 * other side never arrived — and returned it into a generator value the
 * base class discarded.
 */
describe('TransactionRouter — a provider retracts the completeness claim', () => {
  const EVENT = {
    externalId: 'evt-1',
    occurredAt: new Date('2024-06-01T10:00:00Z'),
    kind: 'deposit',
    primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1' },
  } as TransactionEvent;

  test('a retraction overrides the claim a since-less run would have made', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
      retractWith: ['kraken: the ledger contradicts itself over the 492 entries returned'],
    });

    const result = await router.run(request);

    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.historyRetractions).toEqual([
      'kraken: the ledger contradicts itself over the 492 entries returned',
    ]);
  });

  // The negative control, and the one that matters most: a guard that
  // retracted unconditionally would look identical to this fix on every
  // other test in this file, and would silently downgrade the cost basis of
  // all 45 production holdings that legitimately claim a complete history.
  test('a provider that retracts nothing still claims a complete history', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
    });

    const result = await router.run(request);

    expect(result.hasCompleteTxHistory).toBe(true);
    expect(result.historyRetractions).toEqual([]);
  });

  test('the reason reaches the run warnings, where a person reads it', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
      retractWith: ['kraken: the ledger walk stopped at the 20-page cap'],
    });

    const result = await router.run(request);

    expect(result.warnings).toContain('kraken: the ledger walk stopped at the 20-page cap');
  });

  // A run that fetched nothing is exactly the shape a revoked key takes —
  // the case where the reason matters most and the events cannot carry it.
  test('a retraction on a run that returned no events retracts and still explains', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      retractWith: ['kraken: no API key was available, so no ledger was walked at all'],
    });

    const result = await router.run(request);

    expect(result.events).toHaveLength(0);
    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.warnings).toEqual([
      'kraken: no API key was available, so no ledger was walked at all',
    ]);
  });

  test('two retractions are two reasons and one retraction', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
      retractWith: ['etherscan: native stopped early', 'etherscan: internal stopped early'],
    });

    const result = await router.run(request);

    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.historyRetractions).toHaveLength(2);
  });

  // A provider cannot know what the caller asked for, so the channel is
  // one-way by construction: there is nothing on the context that raises
  // the flag. This asserts the shape rather than a behaviour, because the
  // failure it guards against is someone adding the counterpart later and
  // letting a nightly window declare a whole ledger.
  test('an incremental run a provider does not retract stays unclaimed', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
    });

    const result = await router.run({ ...request, since: new Date('2026-01-01T00:00:00Z') });

    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.historyRetractions).toEqual([]);
  });
});

/**
 * SC-900 — the router carries how far back the walk reached, not only that it
 * came back short.
 *
 * `has_complete_tx_history = false` says the ledger does not reach the
 * beginning. It does not say where the ledger DOES begin, and without that a
 * reconciliation shortfall with a known, permanent cause is indistinguishable
 * from one nobody can account for.
 */
describe('TransactionRouter — a retraction can say how far back it reached', () => {
  const EVENT = {
    externalId: 'evt-1',
    occurredAt: new Date('2024-06-01T10:00:00Z'),
    kind: 'deposit',
    primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1' },
  } as TransactionEvent;

  const WINDOW_OPENS = new Date('2024-03-01T00:00:00Z');

  test('the stated bound reaches the result', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
      retractWith: ['stub: this statement covers 2024-03-01 onward'],
      retractBounds: [WINDOW_OPENS],
    });

    const result = await router.run(request);

    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.historyStartsAt).toEqual(WINDOW_OPENS);
  });

  /**
   * THE CONTROL. A retraction that names no boundary must leave the field
   * null rather than defaulting to a date — the whole value of the field is
   * that its absence means "nobody has established this", and a default would
   * turn every retraction in the product into a stated window.
   */
  test('a retraction with no bound leaves it null', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
      retractWith: ['stub: the ledger contradicts itself'],
    });

    const result = await router.run(request);

    expect(result.hasCompleteTxHistory).toBe(false);
    expect(result.historyStartsAt).toBeNull();
  });

  test('a run that retracts nothing states no window either', async () => {
    const { router, request } = setup({ events: [EVENT], withProviderForInstitution: 'kraken' });
    const result = await router.run(request);
    expect(result.historyStartsAt).toBeNull();
  });

  /**
   * The EARLIEST of what was stated, not the last to speak. The field is read
   * as "money that moved before this has no row here", so it must never reach
   * further forward than the ledger actually does or it explains away rows we
   * hold.
   */
  test('two bounds reduce to the earlier one, whichever order they arrive in', async () => {
    const { router, request } = setup({
      events: [EVENT],
      withProviderForInstitution: 'kraken',
      retractWith: ['stub: window A', 'stub: window B'],
      retractBounds: [new Date('2024-09-01T00:00:00Z'), WINDOW_OPENS],
    });

    const result = await router.run(request);

    expect(result.historyStartsAt).toEqual(WINDOW_OPENS);
  });

  /**
   * A run that fetched nothing still tells the coordinator what it reached —
   * zero events is the shape a revoked key or an emptied feed takes, and the
   * empty-result path is a second construction site that can silently drop a
   * field the populated one carries.
   */
  test('an empty run carries the bound too', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      retractWith: ['stub: this statement covers 2024-03-01 onward'],
      retractBounds: [WINDOW_OPENS],
    });

    const result = await router.run(request);

    expect(result.events).toEqual([]);
    expect(result.historyStartsAt).toEqual(WINDOW_OPENS);
  });
});
