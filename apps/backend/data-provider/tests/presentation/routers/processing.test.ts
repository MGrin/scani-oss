import { afterEach, beforeEach, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '../../../../../../packages/business/domain/test/helpers/container';
import { processingRouter } from '../../../src/presentation/routers/processing';
import {
  buildAuthedContext,
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

const registerFinnhubAndYahoo = () => {
  state.registry.register({
    providerKey: 'finnhub',
    capabilities: ['current-price'],
    canPrice: () => false,
    fetchCurrentPrice: async () => null,
  });
  const yahooRow = (t: { id: string }) => ({
    tokenId: t.id,
    baseTokenId: 'usd',
    price: '12.34',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    source: 'yahoo-finance',
  });
  state.registry.register({
    providerKey: 'yahoo-finance',
    capabilities: ['current-price', 'historical-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (t: { id: string }) => yahooRow(t),
    fetchHistoricalPrice: async (t: { id: string }) => yahooRow(t),
    fetchHistoricalRange: async (t: { id: string }) => [yahooRow(t)],
  });
};
const xeqt = { ...btc, symbol: 'XEQT.TO' };

test("Scani's own key still falls back to Yahoo for stocks Finnhub cannot price", async () => {
  registerFinnhubAndYahoo();
  const result = await processingRouter
    .createCaller(buildAuthedContext())
    .v1.prices({ provider: 'finnhub', tokens: [xeqt], baseCurrency: usd });
  expect(result[0]?.source).toBe('yahoo-finance');
});

// SC-1586: Yahoo's terms forbid commercial reuse and redistribution, so a
// customer key is never served a Yahoo price, directly or as a fallback.
test('a customer key gets no Yahoo fallback', async () => {
  registerFinnhubAndYahoo();
  const result = await processingRouter
    .createCaller(buildCustomerContext())
    .v1.prices({ provider: 'finnhub', tokens: [xeqt], baseCurrency: usd });
  expect(result).toEqual([]);
});

test('a customer key naming Yahoo is refused on every pricing route', async () => {
  registerFinnhubAndYahoo();
  const caller = processingRouter.createCaller(buildCustomerContext()).v1;
  const yahoo = { provider: 'yahoo-finance' as const, baseCurrency: usd };
  await expect(caller.prices({ ...yahoo, tokens: [xeqt] })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(
    caller.prices({ ...yahoo, tokens: [xeqt], at: '2026-01-01T00:00:00Z' })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    caller.range({
      ...yahoo,
      token: xeqt,
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-03T00:00:00Z',
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const internal = processingRouter.createCaller(buildAuthedContext()).v1;
  expect((await internal.prices({ ...yahoo, tokens: [xeqt] }))[0]?.source).toBe('yahoo-finance');
});

test('capabilities list Yahoo to Scani only', async () => {
  registerFinnhubAndYahoo();
  const customer = await processingRouter.createCaller(buildCustomerContext()).v1.capabilities();
  const internal = await processingRouter.createCaller(buildAuthedContext()).v1.capabilities();
  expect(customer.pricing).toEqual(['finnhub']);
  expect(internal.pricing).toEqual(['finnhub', 'yahoo-finance']);
});

test('historical endpoint preserves an explicit close day and an explicit instant', async () => {
  const row = (barDay: string | null) => ({
    tokenId: 'btc',
    baseTokenId: 'usd',
    price: '100',
    timestamp: new Date('2026-01-02T00:00:00Z'),
    source: 'coingecko_historical',
    barDay,
  });
  state.registry.register({
    providerKey: 'coingecko',
    capabilities: ['current-price', 'historical-price'],
    canPrice: () => true,
    fetchCurrentPrice: async () => null,
    fetchHistoricalPrice: async () => row('2026-01-01'),
    fetchHistoricalRange: async () => [row('2026-01-01'), row(null)],
  });
  const caller = processingRouter.createCaller(buildCustomerContext()).v1;
  const single = await caller.prices({
    provider: 'coingecko',
    tokens: [btc],
    baseCurrency: usd,
    at: '2026-01-01T00:00:00Z',
  });
  const range = await caller.range({
    provider: 'coingecko',
    token: btc,
    baseCurrency: usd,
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-03T00:00:00Z',
  });
  expect(single[0]?.barDay).toBe('2026-01-01');
  expect(range.map((r) => r.barDay)).toEqual(['2026-01-01', null]);
});
