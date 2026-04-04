import { describe, expect, it } from 'bun:test';
import { exchangeConfigs } from './exchangeConfigs';

describe('exchangeConfigs', () => {
  it('should have 14 exchange configurations', () => {
    expect(exchangeConfigs).toHaveLength(14);
  });

  it('should include all expected exchanges', () => {
    const names = exchangeConfigs.map((c) => c.name).sort();
    expect(names).toContain('Binance');
    expect(names).toContain('Kraken');
    expect(names).toContain('Wise');
    expect(names).toContain('Bybit');
    expect(names).toContain('OKX');
    expect(names).toContain('Interactive Brokers');
    expect(names).toContain('KuCoin');
    expect(names).toContain('Gate.io');
    expect(names).toContain('Coinbase');
    expect(names).toContain('Bitstamp');
    expect(names).toContain('Gemini');
    expect(names).toContain('MEXC');
    expect(names).toContain('Bitget');
    expect(names).toContain('Huobi');
  });

  it('each config should have required fields', () => {
    for (const config of exchangeConfigs) {
      expect(config.institutionId).toBeTruthy();
      expect(config.name).toBeTruthy();
      expect(config.type).toBeTruthy();
      expect(config.authType).toBeTruthy();
      expect(typeof config.createIntegration).toBe('function');
    }
  });

  it('each config should have unique institutionId', () => {
    const ids = exchangeConfigs.map((c) => c.institutionId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('each config should create a valid integration instance', () => {
    for (const config of exchangeConfigs) {
      const integration = config.createIntegration();
      expect(integration).toBeTruthy();
      expect(typeof integration.fetchAccounts).toBe('function');
      expect(typeof integration.fetchHoldings).toBe('function');
      expect(typeof integration.mapToken).toBe('function');
      expect(typeof integration.validateCredentials).toBe('function');
    }
  });

  it('all exchanges should use api_key auth type', () => {
    for (const config of exchangeConfigs) {
      expect(config.authType).toBe('api_key');
    }
  });
});
