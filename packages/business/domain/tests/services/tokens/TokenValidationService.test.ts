import { afterEach, describe, expect, test } from 'bun:test';
import { resetCloudClient, setCloudClient } from '@scani/cloud-client/runtime';
import { TokenValidationService } from '../../../src/services/tokens/TokenValidationService';

interface SearchResult {
  symbol: string;
  name: string;
  type: string;
  currency?: string;
  exchange?: string;
  provider: string;
  providerMetadata?: Record<string, unknown>;
}

function stubCloudClient(results: SearchResult[]): void {
  setCloudClient({
    tokens: {
      search: {
        query: async () => results,
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: shaped only enough for the service under test
  } as any);
}

afterEach(() => {
  resetCloudClient();
});

const service = new TokenValidationService();

describe('TokenValidationService — fiat ISO-4217 ranking', () => {
  test('USD prefers fiat result over Finnhub equity (ProShares Ultra Semiconductors)', async () => {
    stubCloudClient([
      {
        symbol: 'USD',
        name: 'PROSHARES ULTRA SEMICONDUCTORS',
        type: 'Equity',
        provider: 'finnhub',
      },
      {
        symbol: 'USD',
        name: 'United States Dollar',
        type: 'fiat',
        provider: 'database',
      },
    ]);

    const result = await service.validateToken('USD');
    expect(result.isValid).toBe(true);
    expect(result.metadata?.name).toBe('United States Dollar');
    expect(result.metadata?.type).toBe('fiat');
  });

  test('EUR prefers fiat over ProShares Ultra Euro', async () => {
    stubCloudClient([
      { symbol: 'EUR', name: 'ProShares Ultra Euro', type: 'ETF', provider: 'finnhub' },
      { symbol: 'EUR', name: 'Euro', type: 'fiat', provider: 'database' },
    ]);

    const result = await service.validateToken('EUR');
    expect(result.metadata?.name).toBe('Euro');
  });

  test('non-fiat symbol still prefers Finnhub by default (existing behavior)', async () => {
    stubCloudClient([
      { symbol: 'AAPL', name: 'Apple Inc.', type: 'Equity', provider: 'finnhub' },
      { symbol: 'AAPL', name: 'Apple-themed memecoin', type: 'Crypto', provider: 'coingecko' },
    ]);

    const result = await service.validateToken('AAPL');
    expect(result.metadata?.name).toBe('Apple Inc.');
  });

  test('crypto hint still prefers CoinGecko (existing behavior)', async () => {
    stubCloudClient([
      { symbol: 'ETH', name: 'iShares Ethereum ETF', type: 'ETF', provider: 'finnhub' },
      { symbol: 'ETH', name: 'Ethereum', type: 'Crypto', provider: 'coingecko' },
    ]);

    const result = await service.validateToken('ETH', 'crypto');
    expect(result.metadata?.name).toBe('Ethereum');
  });

  test('explicit fiat hint forces fiat preference even for non-ISO-4217 symbol', async () => {
    stubCloudClient([
      { symbol: 'XYZ', name: 'XYZ Equity', type: 'Equity', provider: 'finnhub' },
      { symbol: 'XYZ', name: 'XYZ Currency', type: 'fiat', provider: 'database' },
    ]);

    const result = await service.validateToken('XYZ', 'fiat');
    expect(result.metadata?.name).toBe('XYZ Currency');
  });

  test('handles typeName variant (DB rows expose typeName not type)', async () => {
    // The api router returns typeName='Fiat Currency' on DB hits even
    // when the underlying type code is 'fiat'. The cast here mirrors
    // that real-world shape; the service must still classify it as fiat.
    const dbHit = {
      symbol: 'GBP',
      name: 'British Pound Sterling',
      type: 'fiat',
      typeName: 'Fiat Currency',
      provider: 'database',
    };
    stubCloudClient([
      { symbol: 'GBP', name: 'ProShares Ultra GBP', type: 'Equity', provider: 'finnhub' },
      dbHit as SearchResult,
    ]);

    const result = await service.validateToken('GBP');
    expect(result.metadata?.name).toBe('British Pound Sterling');
  });

  test('returns isValid=false when no exact symbol match', async () => {
    stubCloudClient([
      { symbol: 'OTHER', name: 'Other Token', type: 'Crypto', provider: 'coingecko' },
    ]);
    const result = await service.validateToken('USD');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('returns isValid=false when cloud client not configured', async () => {
    setCloudClient(null);
    const result = await service.validateToken('USD');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Cloud client not configured');
  });
});
