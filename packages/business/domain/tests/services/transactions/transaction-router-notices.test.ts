process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { NoticeInput, ProviderContext, TransactionEvent } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import {
  TransactionRouter,
  type TransactionRouterRequest,
} from '../../../src/services/transactions/TransactionRouter';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const DAY_MS = 24 * 60 * 60 * 1000;

function baseCurrency(): Token {
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

function event(): TransactionEvent {
  return {
    externalId: 'evt-1',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    kind: 'deposit',
    primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1' },
  } as TransactionEvent;
}

interface Opts {
  events?: TransactionEvent[];
  horizonMs?: number;
  retractWith?: readonly NoticeInput[];
  noteWith?: readonly NoticeInput[];
  /** Makes every identity lookup throw, to exercise the keyed failure line. */
  identityThrows?: string;
  since?: Date;
}

function run(opts: Opts) {
  const provider: TransactionsProvider = {
    providerKey: 'binance',
    capabilities: ['transactions'],
    canFetchTransactions: (code: string) => code === 'binance',
    fetchTransactions: async (ctx) => {
      for (const reason of opts.retractWith ?? []) ctx.retractHistoryClaim?.(reason);
      for (const reason of opts.noteWith ?? []) ctx.noteWarning?.(reason);
      return opts.events ?? [];
    },
    transactionHistoryHorizonMs: opts.horizonMs,
  };

  const registry = new ProviderRegistry();
  registry.register(provider);
  Container.set(ProviderRegistry, registry);

  Container.set(TokenIdentityService, {
    findOrCreateByIdentity: async () => {
      if (opts.identityThrows) throw new Error(opts.identityThrows);
      return { id: 'token-BTC' } as never;
    },
    findByIdentity: async () => {
      if (opts.identityThrows) throw new Error(opts.identityThrows);
      return { id: 'token-BTC' } as never;
    },
  } as unknown as TokenIdentityService);

  Container.set(HoldingService, {
    findOrCreateForIngest: async () => ({ id: 'holding-1' }),
    findExistingForIngest: async () => ({ id: 'holding-1' }),
  } as unknown as HoldingService);

  Container.set(TokenTypeRepository, {
    findByCode: async () => ({ id: 'crypto-type-id' }) as never,
    findByCodes: async (codes: string[]) =>
      codes.map((code) => ({ id: `${code}-type-id`, code })) as never,
  } as unknown as TokenTypeRepository);

  const router = new TransactionRouter();
  Container.set(TransactionRouter, router);

  const request: TransactionRouterRequest = {
    userId: 'u1',
    accountId: 'a1',
    institutionId: 'inst-1',
    institutionCode: 'binance',
    source: 'binance-api',
    baseCurrency: baseCurrency(),
    since: opts.since,
    resolveCredentials: (async () => ({
      apiKey: 'x',
      apiSecret: 'y',
    })) as ProviderContext['resolveCredentials'],
  };

  return router.run(request);
}

/**
 * The invariant the client's fallback rests on (SC-434).
 *
 * `warnings` is what 182 already-stored rows hold and what a client too old
 * to know about `warningDetails` still reads. The two are the same list said
 * twice, so a reader may take either — and `readJobLines` in the frontend
 * refuses to zip them when the lengths disagree precisely because a
 * mismatched pair would attach one line's key to another line's sentence.
 */
describe('TransactionRouter — warnings and warningDetails are the same list', () => {
  test('index-aligned, on a result with events', async () => {
    const result = await run({
      events: [event()],
      horizonMs: 5 * 365 * DAY_MS,
      retractWith: ['the paginator stopped early'],
      noteWith: ['an annotation lookup ran short'],
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warningDetails).toHaveLength(result.warnings.length);
    expect(result.warningDetails.map((d) => d.text)).toEqual(result.warnings);
  });

  test('index-aligned, on a result with no events at all', async () => {
    const result = await run({
      horizonMs: 30 * DAY_MS,
      retractWith: ['the paginator stopped early'],
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warningDetails.map((d) => d.text)).toEqual(result.warnings);
  });
});

/**
 * A producer with no key is not broken, deferred, or a lint error — it is a
 * producer whose sentence is not keyed, and it renders exactly what it
 * renders today. That is what makes the mechanism adoptable one site at a
 * time rather than in one migration.
 */
describe('TransactionRouter — an unkeyed sentence still works', () => {
  test('a plain string arrives as a notice with a null key and its text intact', async () => {
    const result = await run({ retractWith: ['bitstamp: the ledger walk stopped early'] });

    const plain = result.warningDetails.find((d) => d.text.startsWith('bitstamp:'));
    expect(plain).toBeDefined();
    expect(plain?.key).toBeNull();
    expect(plain?.text).toBe('bitstamp: the ledger walk stopped early');
  });
});

describe('TransactionRouter — the horizon sentence carries its key (SC-434)', () => {
  test('a five-year horizon travels as a count and a unit, not as English', async () => {
    const result = await run({ horizonMs: 5 * 365 * DAY_MS });

    const horizon = result.warningDetails[0];
    expect(horizon?.key).toBe('v3.jobs.notices.providerHorizon');
    expect(horizon?.params).toEqual({
      provider: 'binance',
      durationCount: 5,
      durationUnit: 'year',
    });
    // The English is still there, so a client that cannot resolve the key
    // renders what shipped before any of this.
    expect(horizon?.text).toContain('reaches 5 years back and no further');
  });

  test('a thirty-day horizon reports days, not a rounded-to-zero year', async () => {
    const result = await run({ horizonMs: 30 * DAY_MS });

    expect(result.warningDetails[0]?.params).toEqual({
      provider: 'binance',
      durationCount: 1,
      durationUnit: 'month',
    });
  });

  test('a run that asked for a window says nothing — the guard is unchanged', async () => {
    const result = await run({ horizonMs: 5 * 365 * DAY_MS, since: new Date('2026-01-01') });

    expect(result.warnings).toEqual([]);
    expect(result.warningDetails).toEqual([]);
  });
});

/**
 * The frame is ours and the tail is not (SC-434). An upstream message cannot
 * be keyed — it is written by something outside this app — so it travels as
 * a param and renders verbatim inside a translated sentence.
 */
describe('TransactionRouter — an upstream message rides inside a keyed frame', () => {
  test('the key names the failure and the param carries the untranslatable text', async () => {
    const result = await run({
      events: [event()],
      identityThrows: 'CoinGecko rejected request: 429 Too Many Requests',
    });

    const failure = result.warningDetails.find(
      (d) => d.key === 'v3.jobs.notices.tokenIdentityFailed'
    );
    expect(failure).toBeDefined();
    expect(failure?.params?.error).toBe('CoinGecko rejected request: 429 Too Many Requests');
    expect(String(failure?.params?.identity)).toContain('BTC');
  });
});
