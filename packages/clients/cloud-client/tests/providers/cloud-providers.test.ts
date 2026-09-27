import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fromCloudAsset } from '@scani/providers/core/cloud-contract';
import { getSharedRedis, setSharedRedis } from '@scani/rate-limiter';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { Redis } from 'ioredis';
import { processingRouter } from '../../../../../apps/backend/data-provider/src/presentation/routers/processing';
import { router } from '../../../../../apps/backend/data-provider/src/presentation/trpc';
import {
  buildCustomerContext,
  installFreshRegistry,
} from '../../../../../apps/backend/data-provider/tests/helpers/test-context';
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import { createCloudClient } from '../../src/client';
import { CloudAIProvider, CloudPricingProvider } from '../../src/providers/platform';
import { CloudWalletProvider } from '../../src/providers/wallet';

restoreContainerAfterAll();
const appRouter = router({ processing: processingRouter });
let state: ReturnType<typeof installFreshRegistry>;
const previousRedis = getSharedRedis();
beforeEach(() => {
  state = installFreshRegistry();
  const rows = new Map<string, string>();
  setSharedRedis({
    get: async (k: string) => rows.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && rows.has(k)) return null;
      rows.set(k, v);
      return 'OK';
    },
    eval: async () => 0,
  } as unknown as Redis);
});
afterEach(() => {
  state.restore();
  setSharedRedis(previousRedis);
});
const requests: string[] = [];
const client = createCloudClient({
  url: 'https://cloud.example',
  apiKey: 'only-scani-cloud-key',
  fetch: async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    expect(request.headers.get('authorization')).toBe('Bearer only-scani-cloud-key');
    if (typeof init.body === 'string') requests.push(init.body);
    return fetchRequestHandler({
      endpoint: '/trpc',
      req: request,
      router: appRouter,
      createContext: () => buildCustomerContext(),
    });
  },
});
const usd = fromCloudAsset({ id: 'usd', symbol: 'USD', name: 'Dollar', typeId: 'fiat' });
const btc = fromCloudAsset({ id: 'btc', symbol: 'BTC', name: 'Bitcoin', typeId: 'crypto' });

test('pricing adapter round trips real HTTP envelopes without sending ownership or credentials', async () => {
  state.registry.register({
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async () => ({
      tokenId: 'btc',
      baseTokenId: 'usd',
      price: '1.00000000000000001',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      source: 'coingecko',
    }),
  });
  requests.length = 0;
  const provider = new CloudPricingProvider(client, 'coingecko');
  const result = await provider.fetchCurrentPrice(
    { ...btc, createdByUserId: 'private-owner' },
    {
      baseCurrency: usd,
      userId: 'private-user',
      resolveCredentials: async () => ({ apiSecret: 'private-key' }),
    }
  );
  expect(result?.price).toBe('1.00000000000000001');
  expect(result?.timestamp).toBeInstanceOf(Date);
  expect(requests.join('')).not.toMatch(
    /private-owner|private-user|private-key|createdByUserId|resolveCredentials/
  );
});

test('cloud outage propagates without direct-provider fallback', async () => {
  const offline = createCloudClient({
    url: 'https://cloud.example',
    apiKey: 'only-scani-cloud-key',
    fetch: async () => {
      throw new Error('cloud offline');
    },
  });
  await expect(
    new CloudPricingProvider(offline, 'coingecko').fetchCurrentPrice(btc, { baseCurrency: usd })
  ).rejects.toThrow('cloud offline');
});

test('AI adapter forwards custom extraction prompts and usage through HTTP', async () => {
  state.registry.register({
    providerKey: 'ai-stub',
    capabilities: ['ai-inference'],
    parseScreenshot: async () => ({ data: {} }),
    parseDocumentText: async (text: string, hint: string, systemPrompt: string) => ({
      data: { text, hint, systemPrompt },
      usage: { tokensIn: 12, tokensOut: 3, totalTokens: 15, upstreamCostUsd: 0.001 },
    }),
  });
  const result = await new CloudAIProvider(client).parseDocumentText(
    'document',
    'context',
    'custom schema'
  );
  expect(result.data).toEqual({ text: 'document', hint: 'context', systemPrompt: 'custom schema' });
  expect(result.usage?.totalTokens).toBe(15);
});

test('wallet adapter transmits only address and restores history retractions over HTTP', async () => {
  state.registry.register({
    providerKey: 'bitcoin',
    capabilities: ['transactions', 'address-validator'],
    canFetchTransactions: () => true,
    canValidate: () => true,
    isValidAddress: () => true,
    hasActivity: async () => true,
    fetchTransactions: async (ctx: {
      retractHistoryClaim: (reason: string, bound: object) => void;
    }) => {
      ctx.retractHistoryClaim('partial', { historyStartsAt: new Date('2025-01-01T00:00:00Z') });
      return [
        {
          externalId: 't',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BTC' }, quantity: '1' },
        },
      ];
    },
  });
  requests.length = 0;
  const provider = new CloudWalletProvider(client, 'bitcoin');
  const bounds: Date[] = [];
  const rows = await provider.fetchTransactions({
    institutionCode: 'bitcoin',
    baseCurrency: usd,
    credentialsRef: { userId: 'private-owner', institutionId: 'private-id' },
    resolveCredentials: async () => ({ walletAddress: 'public-wallet', apiSecret: 'never-leave' }),
    retractHistoryClaim: (_reason, bound) => {
      if (bound) bounds.push(bound.historyStartsAt);
    },
  });
  expect(rows[0]?.occurredAt).toBeInstanceOf(Date);
  expect(bounds[0]?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  expect(requests.join('')).not.toMatch(/private-owner|private-id|never-leave|apiSecret/);
  expect(provider.fetchExitedPositions).toBeUndefined();
});

test('wallet position probes batch more than twenty IDs without dropping positions', async () => {
  const batchSizes: number[] = [];
  state.registry.register({
    providerKey: 'etherscan',
    capabilities: ['current-balances', 'address-validator'],
    canFetchBalances: () => true,
    fetchBalances: async () => [],
    canValidate: () => true,
    isValidAddress: () => true,
    hasActivity: async () => true,
    probePositions: async (_ctx: unknown, ids: string[]) => {
      batchSizes.push(ids.length);
      return ids.map((externalId) => ({ externalId, state: 'exited' }));
    },
  });
  const provider = new CloudWalletProvider(client, 'etherscan');
  const result = await provider.probePositions?.(
    {
      institutionCode: 'ethereum',
      baseCurrency: usd,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({ walletAddress: '0x' + 'a'.repeat(40) }),
    },
    Array.from({ length: 21 }, (_, i) => `token-${i}`)
  );
  expect(result).toHaveLength(21);
  expect(batchSizes).toEqual([20, 1]);
});
