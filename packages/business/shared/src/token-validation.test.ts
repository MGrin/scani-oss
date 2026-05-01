import { describe, expect, it } from 'bun:test';
import { TokenMetadataSchema, TokenValidationResultSchema } from './token-validatiion';

describe('TokenMetadataSchema', () => {
  it('should accept valid metadata', () => {
    const result = TokenMetadataSchema.safeParse({
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'Crypto',
      provider: 'coingecko',
    });
    expect(result.success).toBe(true);
  });

  it('should accept all optional fields', () => {
    const result = TokenMetadataSchema.safeParse({
      symbol: 'AAPL',
      name: 'Apple Inc',
      type: 'Equity',
      currency: 'USD',
      exchange: 'NASDAQ',
      description: 'Tech company',
      provider: 'finnhub',
      providerMetadata: { mic: 'XNAS' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty symbol', () => {
    const result = TokenMetadataSchema.safeParse({
      symbol: '',
      name: 'Test',
      type: 'Crypto',
      provider: 'coingecko',
    });
    expect(result.success).toBe(false);
  });

  it('should reject symbol over 40 chars', () => {
    const result = TokenMetadataSchema.safeParse({
      symbol: 'A'.repeat(41),
      name: 'Test',
      type: 'Crypto',
      provider: 'coingecko',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid provider', () => {
    const result = TokenMetadataSchema.safeParse({
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'Crypto',
      provider: 'unknown_provider',
    });
    expect(result.success).toBe(false);
  });

  it('should accept all valid providers', () => {
    for (const provider of ['finnhub', 'coingecko', 'defillama']) {
      const result = TokenMetadataSchema.safeParse({
        symbol: 'TEST',
        name: 'Test',
        type: 'Crypto',
        provider,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('TokenValidationResultSchema', () => {
  it('should accept valid result', () => {
    const result = TokenValidationResultSchema.safeParse({
      isValid: true,
      metadata: {
        symbol: 'ETH',
        name: 'Ethereum',
        type: 'Crypto',
        provider: 'coingecko',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept invalid result with error', () => {
    const result = TokenValidationResultSchema.safeParse({
      isValid: false,
      error: 'Token not found',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing isValid', () => {
    const result = TokenValidationResultSchema.safeParse({
      metadata: { symbol: 'X', name: 'X', type: 'X', provider: 'coingecko' },
    });
    expect(result.success).toBe(false);
  });
});
