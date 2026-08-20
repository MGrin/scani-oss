process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext, TransactionEvent } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
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
    iconUrl: null,
    lastPricingAttemptAt: null,
    lookalikeOf: null,
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
  /** Token ids the stubbed `HoldingService.findExistingForIngest`
      reports as already having a holding. Used to exercise the
      wallet-source FIND-ONLY path. */
  existingHoldingTokenIds?: Set<string>;
  /** Symbols the stubbed `TokenIdentityService.findByIdentity` already has
      a `tokens` row for. Anything else is unknown to the database, so a
      find-only lookup misses and only a create would materialize it. */
  existingTokenSymbols?: Set<string>;
  /** Mirrors a provider that substitutes its own look-back when handed no
      `since` (Bybit, Bitget, OKX). */
  transactionHistoryHorizonMs?: number;
  /** Reasons the stub provider retracts with during the walk (SC-395).
      Mirrors a paginator that set out for the whole ledger and came back
      knowing it had not reached the end. */
  retractWith?: readonly string[];
  /** Reasons the stub provider reports WITHOUT retracting (SC-428) — a walk
      that annotates rather than produces, such as bitstamp's txid lookup. */
  noteWith?: readonly string[];
}

function setup(opts: SetupOpts): {
  router: TransactionRouter;
  fetchCalls: number;
  request: TransactionRouterRequest;
  createdTokenSymbols: string[];
  identityLookups: () => number;
} {
  let fetchCalls = 0;
  let identityLookups = 0;
  const createdTokenSymbols: string[] = [];

  const provider: TransactionsProvider = {
    providerKey: 'stub',
    capabilities: ['transactions'],
    canFetchTransactions: (institutionCode: string) =>
      institutionCode === opts.withProviderForInstitution,
    fetchTransactions: async (ctx) => {
      fetchCalls++;
      for (const reason of opts.retractWith ?? []) ctx.retractHistoryClaim?.(reason);
      for (const reason of opts.noteWith ?? []) ctx.noteWarning?.(reason);
      return opts.events;
    },
    transactionHistoryHorizonMs: opts.transactionHistoryHorizonMs,
  };

  const registry = new ProviderRegistry();
  if (opts.withProviderForInstitution) registry.register(provider);
  Container.set(ProviderRegistry, registry);

  // Stubs for TokenIdentityService, HoldingService, TokenTypeRepository.
  // They simulate "always finds/creates" with deterministic ids.
  Container.set(TokenIdentityService, {
    findOrCreateByIdentity: async (partial: { symbol?: string }) => {
      const symbol = partial.symbol ?? 'unknown';
      if (!opts.existingTokenSymbols?.has(symbol)) createdTokenSymbols.push(symbol);
      return { id: `token-${symbol}` } as never;
    },
    findByIdentity: async (partial: { symbol?: string }) => {
      const symbol = partial.symbol ?? 'unknown';
      identityLookups++;
      // No `existingTokenSymbols` supplied → every token is already known,
      // which is what the pre-SC-343 tests assume.
      const known = opts.existingTokenSymbols?.has(symbol) ?? true;
      return known ? ({ id: `token-${symbol}` } as never) : null;
    },
  } as unknown as TokenIdentityService);

  Container.set(HoldingService, {
    findOrCreateForIngest: async (input: {
      userId: string;
      accountId: string;
      tokenId: string;
    }): Promise<{ id: string }> => ({ id: `holding-${input.tokenId}` }),
    findExistingForIngest: async (input: {
      userId: string;
      accountId: string;
      tokenId: string;
    }): Promise<{ id: string } | null> =>
      opts.existingHoldingTokenIds?.has(input.tokenId) ? { id: `holding-${input.tokenId}` } : null,
  } as unknown as HoldingService);

  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) =>
      code === 'crypto' ? ({ id: 'crypto-type-id' } as never) : ({ id: 'fiat-type-id' } as never),
    findByCodes: async (codes: string[]) =>
      codes.map((code) => ({
        id: code === 'crypto' ? 'crypto-type-id' : `${code}-type-id`,
        code,
      })) as never,
  } as unknown as TokenTypeRepository);

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

  return {
    router,
    fetchCalls: 0,
    request,
    createdTokenSymbols,
    identityLookups: () => identityLookups,
    get fetchCallsCount() {
      return fetchCalls;
    },
  } as never;
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
    expect(result.transactions).toHaveLength(0);
    expect(result.observations).toHaveLength(0);
    expect(result.firstEventAt).toBeNull();
    expect(result.lastEventAt).toBeNull();
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
    // The empty-result and materialized paths build the flag separately, and
    // only the empty one was exercised — a bounded provider that actually
    // returns transactions is the case that reaches the ledger.
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
    expect(result.transactions).toHaveLength(1);
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

  test('materializes a single deposit event into a NewHoldingTransaction', async () => {
    const occurred = new Date('2024-06-01T10:00:00Z');
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      events: [
        {
          externalId: 'deposit-1',
          occurredAt: occurred,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BTC', name: 'Bitcoin' }, quantity: '0.5' },
        },
      ],
    });
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0];
    expect(tx?.kind).toBe('deposit');
    expect(tx?.quantity).toBe('0.5');
    expect(tx?.tokenId).toBe('token-BTC');
    expect(tx?.holdingId).toBe('holding-token-BTC');
    expect(tx?.source).toBe('kraken-api');
    expect(tx?.externalId).toBe('deposit-1');
    expect(tx?.occurredAt.getTime()).toBe(occurred.getTime());
    expect(result.firstEventAt?.getTime()).toBe(occurred.getTime());
    expect(result.lastEventAt?.getTime()).toBe(occurred.getTime());
  });

  // Wallet-derived imports (etherscan, solana, …) are review-gated:
  // the router must FIND-ONLY so a tx referencing a token the user
  // dropped at the wallet-import review can't silently re-create that
  // holding. Exchange sources keep create-on-miss.
  test('wallet source (solana) skips a tx for a token with no pre-existing holding', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'solana',
      existingHoldingTokenIds: new Set(), // nothing pre-created
      events: [
        {
          externalId: 'spl-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BONK', name: 'Bonk' }, quantity: '100' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'solana',
      institutionCode: 'solana',
    });
    // FIND-ONLY: no holding exists → the event is dropped, not created.
    expect(result.transactions).toHaveLength(0);
  });

  test('wallet source (solana) keeps a tx for a token the user kept at review', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'solana',
      existingHoldingTokenIds: new Set(['token-SOL']),
      events: [
        {
          externalId: 'sol-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'SOL', name: 'Solana' }, quantity: '2' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'solana',
      institutionCode: 'solana',
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.tokenId).toBe('token-SOL');
  });

  test('exchange source (kraken-api) still creates a holding on miss', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      existingHoldingTokenIds: new Set(), // nothing pre-created
      events: [
        {
          externalId: 'dep-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'XRP', name: 'XRP' }, quantity: '10' },
        },
      ],
    });
    // request defaults to source 'kraken-api' / institutionCode 'kraken'.
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.tokenId).toBe('token-XRP');
  });

  test('tracks first/last event timestamps across multiple events', async () => {
    const t1 = new Date('2024-05-01T00:00:00Z');
    const t2 = new Date('2024-06-01T00:00:00Z');
    const t3 = new Date('2024-04-01T00:00:00Z');
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      events: [
        {
          externalId: 'a',
          occurredAt: t1,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '1' },
        },
        {
          externalId: 'b',
          occurredAt: t2,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '2' },
        },
        {
          externalId: 'c',
          occurredAt: t3,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '3' },
        },
      ],
    });
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(3);
    // t3 is earliest, t2 latest.
    expect(result.firstEventAt?.getTime()).toBe(t3.getTime());
    expect(result.lastEventAt?.getTime()).toBe(t2.getTime());
  });
});

describe('TransactionRouter — a wallet source mints no token it cannot use (SC-343)', () => {
  // The router resolved the token identity FIRST and the holding second, so a
  // wallet-derived event for a token the user dropped at review wrote a
  ***REMOVED***
  ***REMOVED***
  ***REMOVED***
  // from the real thing.
  //
  // A holding cannot exist without a token row, so under FIND-ONLY a token
  // that is not already in the database can never yield a holding. Creating
  // it is therefore always useless work, and the row it leaves behind is the
  // whole cost.
  test('an unknown token on a wallet source is never created', async () => {
    const { router, request, createdTokenSymbols } = setup({
      withProviderForInstitution: 'ethereum',
      existingTokenSymbols: new Set(),
      existingHoldingTokenIds: new Set(),
      events: [
        {
          externalId: 'spam-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'transfer_in',
          primary: { tokenIdentity: { symbol: 'USDC', name: 'USD Coin' }, quantity: '1000' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.transactions).toHaveLength(0);
    expect(createdTokenSymbols).toEqual([]);
  });

  test('the skip is still reported, so the run does not go quiet about it', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingTokenSymbols: new Set(),
      existingHoldingTokenIds: new Set(),
      events: [
        {
          externalId: 'spam-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'transfer_in',
          primary: { tokenIdentity: { symbol: 'USDC', name: 'USD Coin' }, quantity: '1000' },
        },
        {
          externalId: 'spam-2',
          occurredAt: new Date('2024-06-02T10:00:00Z'),
          kind: 'transfer_in',
          primary: { tokenIdentity: { symbol: 'USDC', name: 'USD Coin' }, quantity: '2000' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.warnings).toEqual([
      "Skipped 2 tx event(s) referencing 1 token(s) the user didn't keep during wallet review.",
    ]);
  });

  test('a token the user kept still resolves and still lands', async () => {
    const { router, request, createdTokenSymbols } = setup({
      withProviderForInstitution: 'ethereum',
      existingTokenSymbols: new Set(['WETH']),
      existingHoldingTokenIds: new Set(['token-WETH']),
      events: [
        {
          externalId: 'real-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'transfer_in',
          primary: { tokenIdentity: { symbol: 'WETH', name: 'Wrapped Ether' }, quantity: '0.4' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.tokenId).toBe('token-WETH');
    expect(createdTokenSymbols).toEqual([]);
  });

  test('an exchange source still creates the token, because a deposit needs no review', async () => {
    const { router, request, createdTokenSymbols } = setup({
      withProviderForInstitution: 'kraken',
      existingTokenSymbols: new Set(),
      existingHoldingTokenIds: new Set(),
      events: [
        {
          externalId: 'dep-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'XRP', name: 'XRP' }, quantity: '10' },
        },
      ],
    });
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(1);
    expect(createdTokenSymbols).toEqual(['XRP']);
  });

  test('the counter side of a surviving swap is still created', async () => {
    // Only the PRIMARY leg gates on a holding. A swap's counter token is
    // priced against, not held, so refusing to materialize it would strip the
    // quote off an event that did land — and a swap leg without its price
    // realizes at zero (SC-332).
    const { router, request, createdTokenSymbols } = setup({
      withProviderForInstitution: 'ethereum',
      existingTokenSymbols: new Set(['WETH']),
      existingHoldingTokenIds: new Set(['token-WETH']),
      events: [
        {
          externalId: 'swap-1',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'swap_out',
          primary: { tokenIdentity: { symbol: 'WETH', name: 'Wrapped Ether' }, quantity: '-1' },
          counter: { tokenIdentity: { symbol: 'AAVE', name: 'Aave' }, quantity: '20' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.counterTokenId).toBe('token-AAVE');
    expect(createdTokenSymbols).toEqual(['AAVE']);
  });

  test('an identity looked up and missed once is not looked up again', async () => {
    // 410 events referencing 124 absent tokens in the production run. Without
    // a negative cache that is 410 queries for 124 answers.
    const { router, request, identityLookups } = setup({
      withProviderForInstitution: 'ethereum',
      existingTokenSymbols: new Set(),
      existingHoldingTokenIds: new Set(),
      events: Array.from({ length: 5 }, (_, i) => ({
        externalId: `spam-${i}`,
        occurredAt: new Date('2024-06-01T10:00:00Z'),
        kind: 'transfer_in' as const,
        primary: { tokenIdentity: { symbol: 'USDC', name: 'USD Coin' }, quantity: '1' },
      })),
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.transactions).toHaveLength(0);
    expect(identityLookups()).toBe(1);
    expect(result.warnings).toEqual([
      "Skipped 5 tx event(s) referencing 1 token(s) the user didn't keep during wallet review.",
    ]);
  });
});

describe('TransactionRouter — swap groups (SC-332)', () => {
  const SWAP_LEGS: TransactionEvent[] = [
    {
      externalId: '0xswap',
      occurredAt: new Date('2024-06-01T10:00:00Z'),
      kind: 'swap_out',
      primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '-1' },
      counter: { tokenIdentity: { symbol: 'USDC' }, quantity: '2000' },
      priceNative: { value: '2000', quoteIdentity: { symbol: 'USDC' } },
      swapGroupKey: '1:0xswap',
    },
    {
      externalId: '0xswap-0xusdc',
      occurredAt: new Date('2024-06-01T10:00:00Z'),
      kind: 'swap_in',
      primary: { tokenIdentity: { symbol: 'USDC' }, quantity: '2000' },
      counter: { tokenIdentity: { symbol: 'ETH' }, quantity: '-1' },
      priceNative: { value: '0.0005', quoteIdentity: { symbol: 'ETH' } },
      swapGroupKey: '1:0xswap',
    },
  ];

  test('both surviving legs of one swap share a single swapGroupId', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingHoldingTokenIds: new Set(['token-ETH', 'token-USDC']),
      events: SWAP_LEGS,
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });

    expect(result.transactions).toHaveLength(2);
    const [out, inn] = result.transactions;
    expect(out?.swapGroupId).toBeTruthy();
    expect(out?.swapGroupId).toBe(inn?.swapGroupId as string);
    expect(out?.kind).toBe('swap_out');
    expect(inn?.kind).toBe('swap_in');
  });

  test('two swaps in one run do not share a swapGroupId', async () => {
    const second = SWAP_LEGS.map((e) => ({
      ...e,
      externalId: `${e.externalId}-b`,
      swapGroupKey: '1:0xother',
    }));
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingHoldingTokenIds: new Set(['token-ETH', 'token-USDC']),
      events: [...SWAP_LEGS, ...second],
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });

    const groups = new Set(result.transactions.map((t) => t.swapGroupId));
    expect(result.transactions).toHaveLength(4);
    expect(groups.size).toBe(2);
  });

  // The half-swap. Wallet sources are FIND-ONLY, so an in-leg whose token has
  // no holding on the account is dropped — and a lone `swap_out` is the worst
  // of both worlds: it leaves the transfer-review queue (whose predicate is
  // `kind IN ('withdraw','transfer_out')`) so nobody can answer it, and it
  // realizes at ZERO because `txValueInBase` refuses to price a swap from the
  // held token. It must go back to being the plain transfer it was.
  test('a swap leg whose partner was dropped reverts to a plain transfer', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingHoldingTokenIds: new Set(['token-ETH']), // USDC has no holding
      events: SWAP_LEGS,
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });

    expect(result.transactions).toHaveLength(1);
    const orphan = result.transactions[0];
    expect(orphan?.kind).toBe('transfer_out');
    expect(orphan?.swapGroupId).toBeNull();
    expect(orphan?.counterTokenId).toBeNull();
    expect(orphan?.priceNative).toBeNull();
  });

  test('an orphaned swap leg is reported as a warning, not silently downgraded', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingHoldingTokenIds: new Set(['token-ETH']),
      events: SWAP_LEGS,
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.warnings.some((w) => /swap/i.test(w))).toBe(true);
  });

  test('an orphaned inflow leg reverts to transfer_in, by its own sign', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingHoldingTokenIds: new Set(['token-USDC']), // ETH has no holding
      events: SWAP_LEGS,
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.kind).toBe('transfer_in');
  });

  test('events with no swapGroupKey are untouched', async () => {
    const { router, request } = setup({
      withProviderForInstitution: 'ethereum',
      existingHoldingTokenIds: new Set(['token-ETH']),
      events: [
        {
          externalId: '0xplain',
          occurredAt: new Date('2024-06-01T10:00:00Z'),
          kind: 'transfer_out',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '-1' },
        },
      ],
    });
    const result = await router.run({
      ...request,
      source: 'etherscan',
      institutionCode: 'ethereum',
    });
    expect(result.transactions[0]?.kind).toBe('transfer_out');
    expect(result.transactions[0]?.swapGroupId).toBeNull();
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

  // The empty-result and materialized paths build the flag separately, and
  // a run that fetched nothing is exactly the shape a revoked key takes —
  // the case where the reason matters most and the events cannot carry it.
  test('a retraction on a run that returned no events retracts and still explains', async () => {
    const { router, request } = setup({
      events: [],
      withProviderForInstitution: 'kraken',
      retractWith: ['kraken: no API key was available, so no ledger was walked at all'],
    });

    const result = await router.run(request);

    expect(result.transactions).toHaveLength(0);
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
