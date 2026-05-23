import { describe, expect, it } from 'bun:test';
import { isFiatCode, tokenTypeForCexAsset } from '../../../src/core/utils/fiat-codes';

describe('isFiatCode', () => {
  it('identifies majors', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD']) {
      expect(isFiatCode(code)).toBe(true);
    }
  });

  it('identifies regional fiats CEXes commonly support', () => {
    for (const code of ['TRY', 'BRL', 'INR', 'KRW', 'SGD', 'AED', 'ZAR']) {
      expect(isFiatCode(code)).toBe(true);
    }
  });

  it('rejects stablecoins (they trade as crypto tokens)', () => {
    for (const code of ['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD', 'PYUSD']) {
      expect(isFiatCode(code)).toBe(false);
    }
  });

  it('rejects crypto majors', () => {
    for (const code of ['BTC', 'ETH', 'SOL', 'BNB', 'ADA', 'XRP', 'DOGE']) {
      expect(isFiatCode(code)).toBe(false);
    }
  });

  it('is case-insensitive', () => {
    expect(isFiatCode('usd')).toBe(true);
    expect(isFiatCode('Eur')).toBe(true);
  });

  it('handles empty / nullish-ish input safely', () => {
    expect(isFiatCode('')).toBe(false);
  });
});

describe('tokenTypeForCexAsset', () => {
  it('returns fiat for ISO 4217 codes', () => {
    expect(tokenTypeForCexAsset('USD')).toBe('fiat');
    expect(tokenTypeForCexAsset('EUR')).toBe('fiat');
  });

  it('returns crypto for stablecoins + crypto majors', () => {
    expect(tokenTypeForCexAsset('USDT')).toBe('crypto');
    expect(tokenTypeForCexAsset('USDC')).toBe('crypto');
    expect(tokenTypeForCexAsset('BTC')).toBe('crypto');
  });
});
