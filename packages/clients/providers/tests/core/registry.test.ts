import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import { ProviderRegistry } from '../../src/core/registry';
import { makeMockToken } from '../../src/core/testing';

function priceProvider(key: string, canPriceFn: (t: Token) => boolean = () => true) {
  return {
    providerKey: key,
    capabilities: ['current-price'] as const,
    canPrice: canPriceFn,
    fetchCurrentPrice: async () => null,
  };
}

function historicalProvider(key: string, canPriceFn: (t: Token) => boolean = () => true) {
  return {
    providerKey: key,
    capabilities: ['current-price', 'historical-price'] as const,
    canPrice: canPriceFn,
    fetchCurrentPrice: async () => null,
    fetchHistoricalPrice: async () => null,
  };
}

function balanceProvider(key: string, institutionCode: string) {
  return {
    providerKey: key,
    capabilities: ['current-balances', 'credential-validator'] as const,
    canFetchBalances: (c: string) => c === institutionCode,
    fetchBalances: async () => [],
    validateCredentials: async () => ({ valid: true }),
  };
}

function dedicatedValidator(key: string) {
  return {
    providerKey: key,
    capabilities: ['credential-validator'] as const,
    validateCredentials: async () => ({ valid: true }),
  };
}

describe('ProviderRegistry', () => {
  test('registers a provider into every capability bucket it satisfies', () => {
    const reg = new ProviderRegistry();
    reg.register(historicalProvider('coingecko'));
    expect(reg.getAllCurrentPricers()).toHaveLength(1);
    expect(reg.getAllHistoricalPricers()).toHaveLength(1);
  });

  test('registration order = dispatch priority', () => {
    const reg = new ProviderRegistry();
    reg.register(priceProvider('first'));
    reg.register(priceProvider('second'));
    expect(reg.getAllCurrentPricers().map((p) => p.providerKey)).toEqual(['first', 'second']);
  });

  test('getCurrentPricers filters by canPrice(token)', () => {
    const reg = new ProviderRegistry();
    const tBtc = makeMockToken({ symbol: 'BTC' });
    const tEur = makeMockToken({ symbol: 'EUR' });
    reg.register(priceProvider('coingecko', (t) => t.symbol === 'BTC'));
    reg.register(priceProvider('frankfurter', (t) => t.symbol === 'EUR'));
    expect(reg.getCurrentPricers(tBtc).map((p) => p.providerKey)).toEqual(['coingecko']);
    expect(reg.getCurrentPricers(tEur).map((p) => p.providerKey)).toEqual(['frankfurter']);
  });

  test('getBalanceFetcher returns null for unknown institution', () => {
    const reg = new ProviderRegistry();
    reg.register(balanceProvider('binance', 'binance'));
    expect(reg.getBalanceFetcher('binance')).not.toBeNull();
    expect(reg.getBalanceFetcher('coinbase')).toBeNull();
  });

  test('getCredentialValidator finds via canFetchBalances', () => {
    const reg = new ProviderRegistry();
    reg.register(balanceProvider('binance', 'binance'));
    expect(reg.getCredentialValidator('binance')?.providerKey).toBe('binance');
  });

  test('getCredentialValidator falls back to providerKey === institutionCode for dedicated validators', () => {
    const reg = new ProviderRegistry();
    reg.register(dedicatedValidator('passkey'));
    expect(reg.getCredentialValidator('passkey')?.providerKey).toBe('passkey');
  });

  test('historical providers also appear in current-price bucket (interface inheritance)', () => {
    const reg = new ProviderRegistry();
    reg.register(historicalProvider('kraken'));
    expect(reg.getAllCurrentPricers()).toHaveLength(1);
    expect(reg.getAllHistoricalPricers()).toHaveLength(1);
  });
});
