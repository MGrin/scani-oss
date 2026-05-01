import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { CloudClient } from '../../src/client';
import { CloudProviderClientBridge } from '../../src/cloud-services/cloud-provider-client';

interface BridgeCall {
  op: string;
  args: unknown;
}

interface StubOpts {
  aiResult?: unknown;
  pricingResult?: unknown;
  tokensResult?: unknown;
  throws?: Error;
}

function stubClient(opts: StubOpts = {}): { client: CloudClient; calls: BridgeCall[] } {
  const calls: BridgeCall[] = [];
  const make =
    (op: string, result: unknown) =>
    async (args: unknown): Promise<unknown> => {
      calls.push({ op, args });
      if (opts.throws) throw opts.throws;
      return result;
    };

  const client = {
    ai: {
      parseScreenshot: { mutate: make('ai.parseScreenshot', opts.aiResult ?? { ok: true }) },
      parseDocumentText: {
        mutate: make('ai.parseDocumentText', opts.aiResult ?? { ok: true }),
      },
      completeText: { mutate: make('ai.completeText', opts.aiResult ?? 'completion-result') },
    },
    pricing: {
      fetchCurrentPrice: { mutate: make('pricing.fetchCurrentPrice', opts.pricingResult ?? null) },
      fetchCurrentPrices: {
        mutate: make('pricing.fetchCurrentPrices', opts.pricingResult ?? []),
      },
      fetchHistoricalPrice: {
        mutate: make('pricing.fetchHistoricalPrice', opts.pricingResult ?? null),
      },
      fetchHistoricalRange: {
        mutate: make('pricing.fetchHistoricalRange', opts.pricingResult ?? []),
      },
    },
    tokens: {
      enrichIdentity: { mutate: make('tokens.enrichIdentity', opts.tokensResult ?? null) },
    },
  };
  return { client: client as unknown as CloudClient, calls };
}

const BTC: Token = {
  id: 'token-btc',
  symbol: 'BTC',
  name: 'Bitcoin',
  typeId: 'crypto',
  decimals: 8,
  iconUrl: null,
  providerMetadata: { coingecko: { id: 'bitcoin' } },
  isScamProbability: 0,
  isActive: true,
  marketSegment: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

describe('CloudProviderClientBridge — AI methods (live)', () => {
  test('parseScreenshot translates args into the data-provider AI route shape', async () => {
    const { client, calls } = stubClient();
    const bridge = new CloudProviderClientBridge(client);
    await bridge.parseScreenshot({
      providerKey: 'openai',
      imageBase64: 'AAA',
      mimeType: 'image/png',
      hint: 'portfolio',
    });
    expect(calls).toEqual([
      {
        op: 'ai.parseScreenshot',
        args: {
          imageBase64: 'AAA',
          options: {
            provider: 'openai',
            mimeType: 'image/png',
            context: 'portfolio',
          },
        },
      },
    ]);
  });

  test('parseDocumentText translates args correctly', async () => {
    const { client, calls } = stubClient();
    const bridge = new CloudProviderClientBridge(client);
    await bridge.parseDocumentText({
      providerKey: 'openai',
      text: 'csv header line',
      hint: 'detect',
    });
    expect(calls[0]?.args).toEqual({
      text: 'csv header line',
      options: { provider: 'openai', context: 'detect' },
    });
  });

  test('completeText returns the string output', async () => {
    const { client } = stubClient({ aiResult: 'hello world' });
    const bridge = new CloudProviderClientBridge(client);
    const out = await bridge.completeText({
      providerKey: 'openai',
      prompt: 'say hi',
      temperature: 0.2,
      maxTokens: 100,
    });
    expect(out).toBe('hello world');
  });

  test('AI methods wrap upstream errors via CloudError', async () => {
    const { client } = stubClient({ throws: new Error('upstream broke') });
    const bridge = new CloudProviderClientBridge(client);
    await expect(
      bridge.parseScreenshot({
        providerKey: 'openai',
        imageBase64: 'A',
        mimeType: 'image/png',
      })
    ).rejects.toThrow();
  });
});

describe('CloudProviderClientBridge — pricing methods (live)', () => {
  test('fetchCurrentPrice forwards token + synthesized baseCurrency to pricing.fetchCurrentPrice', async () => {
    const result = {
      tokenId: 'token-btc',
      baseTokenId: 'token-usd',
      price: '40000',
      timestamp: new Date('2024-01-15'),
      source: 'coingecko',
    };
    const { client, calls } = stubClient({ pricingResult: result });
    const bridge = new CloudProviderClientBridge(client);
    const out = await bridge.fetchCurrentPrice({
      providerKey: 'coingecko',
      token: BTC,
      baseCurrencyId: 'token-usd',
    });
    expect(out).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe('pricing.fetchCurrentPrice');
    const args = calls[0]?.args as {
      providerKey: string;
      token: Token;
      baseCurrency: Token;
    };
    expect(args.providerKey).toBe('coingecko');
    expect(args.token.id).toBe('token-btc');
    expect(args.baseCurrency.id).toBe('token-usd');
  });

  test('fetchCurrentPrices short-circuits on empty token array (no RPC)', async () => {
    const { client, calls } = stubClient();
    const bridge = new CloudProviderClientBridge(client);
    const out = await bridge.fetchCurrentPrices({
      providerKey: 'coingecko',
      tokens: [],
      baseCurrencyId: 'usd',
    });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('fetchCurrentPrices forwards token list', async () => {
    const result = [
      {
        tokenId: 'token-btc',
        quote: {
          tokenId: 'token-btc',
          baseTokenId: 'token-usd',
          price: '40000',
          timestamp: new Date(),
          source: 'coingecko',
        },
      },
    ];
    const { client, calls } = stubClient({ pricingResult: result });
    const bridge = new CloudProviderClientBridge(client);
    const out = await bridge.fetchCurrentPrices({
      providerKey: 'coingecko',
      tokens: [BTC],
      baseCurrencyId: 'token-usd',
    });
    expect(out).toEqual(result);
    expect(calls[0]?.op).toBe('pricing.fetchCurrentPrices');
    const args = calls[0]?.args as { tokens: Token[]; baseCurrency: Token };
    expect(args.tokens).toHaveLength(1);
    expect(args.tokens[0]?.id).toBe('token-btc');
  });

  test('fetchHistoricalPrice forwards `at` timestamp', async () => {
    const at = new Date('2023-06-15T12:00:00Z');
    const { client, calls } = stubClient({ pricingResult: null });
    const bridge = new CloudProviderClientBridge(client);
    await bridge.fetchHistoricalPrice({
      providerKey: 'defillama',
      token: BTC,
      at,
      baseCurrencyId: 'usd',
    });
    expect(calls[0]?.op).toBe('pricing.fetchHistoricalPrice');
    expect((calls[0]?.args as { at: Date }).at).toEqual(at);
  });

  test('fetchHistoricalRange forwards from + to', async () => {
    const from = new Date('2023-01-01');
    const to = new Date('2023-01-31');
    const { client, calls } = stubClient({ pricingResult: [] });
    const bridge = new CloudProviderClientBridge(client);
    await bridge.fetchHistoricalRange({
      providerKey: 'coingecko',
      token: BTC,
      from,
      to,
      baseCurrencyId: 'usd',
    });
    expect(calls[0]?.op).toBe('pricing.fetchHistoricalRange');
    const args = calls[0]?.args as { from: Date; to: Date };
    expect(args.from).toEqual(from);
    expect(args.to).toEqual(to);
  });

  test('pricing methods wrap upstream errors via CloudError', async () => {
    const { client } = stubClient({ throws: new Error('upstream broke') });
    const bridge = new CloudProviderClientBridge(client);
    await expect(
      bridge.fetchCurrentPrice({
        providerKey: 'coingecko',
        token: BTC,
        baseCurrencyId: 'usd',
      })
    ).rejects.toThrow();
  });
});

describe('CloudProviderClientBridge — tokens.enrichIdentity (live)', () => {
  test('forwards partial + force to tokens.enrichIdentity', async () => {
    const result = { coingecko: { id: 'bitcoin' } };
    const { client, calls } = stubClient({ tokensResult: result });
    const bridge = new CloudProviderClientBridge(client);
    const out = await bridge.enrichTokenIdentity({
      providerKey: 'coingecko',
      partial: { symbol: 'BTC' },
      force: true,
    });
    expect(out).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe('tokens.enrichIdentity');
    expect(calls[0]?.args).toEqual({
      providerKey: 'coingecko',
      partial: { symbol: 'BTC' },
      force: true,
    });
  });

  test('null result passes through', async () => {
    const { client } = stubClient({ tokensResult: null });
    const bridge = new CloudProviderClientBridge(client);
    const out = await bridge.enrichTokenIdentity({
      providerKey: 'coingecko',
      partial: { symbol: 'UNKNOWN' },
    });
    expect(out).toBeNull();
  });

  test('upstream errors are wrapped via CloudError', async () => {
    const { client } = stubClient({ throws: new Error('rate limited') });
    const bridge = new CloudProviderClientBridge(client);
    await expect(
      bridge.enrichTokenIdentity({
        providerKey: 'coingecko',
        partial: { symbol: 'BTC' },
      })
    ).rejects.toThrow();
  });
});

describe('CloudProviderClientBridge — balances/transactions (intentionally not-supported)', () => {
  // User-credentialed venues (CEXes, brokers) stay direct-mode in
  // backend's sub-registry. The bridge's class-header comment explains
  // the architectural rationale; this test pins the contract.
  const { client } = stubClient();
  const bridge = new CloudProviderClientBridge(client);

  test('fetchBalances throws not-supported', async () => {
    await expect(
      bridge.fetchBalances({
        institutionCode: 'binance',
        userId: 'u',
        institutionId: 'i',
        baseCurrencyId: 'usd',
      })
    ).rejects.toMatchObject({ kind: 'not-supported' });
  });

  test('fetchTransactions throws not-supported', async () => {
    await expect(
      bridge.fetchTransactions({
        institutionCode: 'binance',
        userId: 'u',
        institutionId: 'i',
        baseCurrencyId: 'usd',
      })
    ).rejects.toMatchObject({ kind: 'not-supported' });
  });
});
