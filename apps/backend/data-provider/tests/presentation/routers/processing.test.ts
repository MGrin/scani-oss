import { afterEach, beforeEach, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '../../../../../../packages/business/domain/test/helpers/container';
import { processingRouter } from '../../../src/presentation/routers/processing';
import {
  buildCustomerContext,
  buildUnauthedContext,
  installFreshRegistry,
} from '../../helpers/test-context';

restoreContainerAfterAll();
let state: ReturnType<typeof installFreshRegistry>;
beforeEach(() => {
  state = installFreshRegistry();
});
afterEach(() => state.restore());
const usd = { id: 'usd', symbol: 'USD', name: 'Dollar', typeId: 'fiat' };
const btc = { id: 'btc', symbol: 'BTC', name: 'Bitcoin', typeId: 'crypto' };

test('customer pricing preserves decimal strings and dates using server provider', async () => {
  state.registry.register({
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token: { id: string }) => ({
      tokenId: token.id,
      baseTokenId: 'usd',
      price: '123.4567890123456789',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      source: 'coingecko',
    }),
  });
  const result = await processingRouter
    .createCaller(buildCustomerContext())
    .v1.prices({ provider: 'coingecko', tokens: [btc], baseCurrency: usd });
  expect(result[0]?.price).toBe('123.4567890123456789');
  expect(result[0]?.timestamp).toBe('2026-01-01T00:00:00.000Z');
});

test('processing requires authentication and rejects database fields and secrets', async () => {
  const input = { provider: 'coingecko' as const, tokens: [btc], baseCurrency: usd };
  await expect(
    processingRouter.createCaller(buildUnauthedContext()).v1.prices(input)
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(
    processingRouter
      .createCaller(buildCustomerContext())
      .v1.prices({ ...input, tokens: [{ ...btc, createdByUserId: 'private' }] } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('wallet history keeps retractions and warnings and accepts only a public address', async () => {
  state.registry.register({
    providerKey: 'bitcoin',
    capabilities: ['address-validator', 'transactions'],
    canValidate: () => true,
    isValidAddress: () => true,
    hasActivity: async () => true,
    canFetchTransactions: () => true,
    fetchTransactions: async (ctx: {
      resolveCredentials: (ref: object) => Promise<object>;
      retractHistoryClaim: (notice: string, bound: object) => void;
      noteWarning: (notice: string) => void;
    }) => {
      expect(await ctx.resolveCredentials({})).toEqual({ walletAddress: 'public-address' });
      ctx.retractHistoryClaim('Partial history', {
        historyStartsAt: new Date('2025-01-01T00:00:00Z'),
      });
      ctx.noteWarning('Source delayed');
      return [
        {
          externalId: 'tx1',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1.01' },
        },
      ];
    },
  });
  const caller = processingRouter.createCaller(buildCustomerContext()).v1;
  const result = await caller.wallet({
    operation: 'transactions',
    institutionCode: 'bitcoin',
    address: 'public-address',
    baseCurrency: usd,
  });
  expect(result.retractions[0]?.historyStartsAt).toBe('2025-01-01T00:00:00.000Z');
  expect(result.warnings).toEqual(['Source delayed']);
  expect(result.transactions[0]?.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  await expect(
    caller.wallet({
      operation: 'transactions',
      institutionCode: 'kraken',
      address: 'x',
      baseCurrency: usd,
      apiSecret: 'must-not-leave',
    } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('cloud stock pricing falls back to Yahoo without customer Google credentials', async () => {
  state.registry.register({
    providerKey: 'finnhub',
    capabilities: ['current-price'],
    canPrice: () => false,
    fetchCurrentPrice: async () => null,
  });
  state.registry.register({
    providerKey: 'yahoo-finance',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (t: { id: string }) => ({
      tokenId: t.id,
      baseTokenId: 'usd',
      price: '12.34',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      source: 'yahoo-finance',
    }),
  });
  const result = await processingRouter
    .createCaller(buildCustomerContext())
    .v1.prices({ provider: 'finnhub', tokens: [{ ...btc, symbol: 'XEQT.TO' }], baseCurrency: usd });
  expect(result[0]?.source).toBe('yahoo-finance');
});
