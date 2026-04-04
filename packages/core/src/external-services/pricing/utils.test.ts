import { describe, expect, it } from 'bun:test';
import {
  isValidPrice,
  normalizeForFinnhubSymbol,
  parseInternationalNumber,
  sanitizeForGoogleFinanceSymbol,
} from './utils';

describe('parseInternationalNumber', () => {
  it('should parse plain numbers', () => {
    expect(parseInternationalNumber('123.45')).toBe(123.45);
    expect(parseInternationalNumber('0')).toBe(0);
    expect(parseInternationalNumber('1000000')).toBe(1000000);
  });

  it('should parse European format (comma decimal)', () => {
    expect(parseInternationalNumber('999,99')).toBe(999.99);
    expect(parseInternationalNumber('1234,56')).toBe(1234.56);
  });

  it('should return null for invalid input', () => {
    expect(parseInternationalNumber(null)).toBeNull();
    expect(parseInternationalNumber(undefined)).toBeNull();
    expect(parseInternationalNumber('')).toBeNull();
    expect(parseInternationalNumber('   ')).toBeNull();
    expect(parseInternationalNumber('abc')).toBeNull();
  });
});

describe('isValidPrice', () => {
  it('should accept positive numbers', () => {
    expect(isValidPrice('100')).toBe(true);
    expect(isValidPrice('0.001')).toBe(true);
    expect(isValidPrice('999999.99')).toBe(true);
  });

  it('should reject zero and negatives', () => {
    expect(isValidPrice('0')).toBe(false);
    expect(isValidPrice('-1')).toBe(false);
  });

  it('should reject invalid strings', () => {
    expect(isValidPrice(null)).toBe(false);
    expect(isValidPrice(undefined)).toBe(false);
    expect(isValidPrice('abc')).toBe(false);
    expect(isValidPrice('')).toBe(false);
  });
});

describe('normalizeForFinnhubSymbol', () => {
  it('should uppercase and trim', () => {
    expect(normalizeForFinnhubSymbol('aapl')).toBe('AAPL');
    expect(normalizeForFinnhubSymbol('  msft  ')).toBe('MSFT');
  });

  it('should strip exchange prefixes', () => {
    expect(normalizeForFinnhubSymbol('NASDAQ:AAPL')).toBe('AAPL');
    expect(normalizeForFinnhubSymbol('NYSE:GS')).toBe('GS');
    expect(normalizeForFinnhubSymbol('NYSEARCA:VOO')).toBe('VOO');
  });

  it('should strip US suffix', () => {
    expect(normalizeForFinnhubSymbol('AAPL:US')).toBe('AAPL');
    expect(normalizeForFinnhubSymbol('AAPL.US')).toBe('AAPL');
  });

  it('should handle empty input', () => {
    expect(normalizeForFinnhubSymbol('')).toBe('');
  });
});

describe('sanitizeForGoogleFinanceSymbol', () => {
  it('should uppercase and remove special chars', () => {
    expect(sanitizeForGoogleFinanceSymbol('aapl')).toBe('AAPL');
    expect(sanitizeForGoogleFinanceSymbol('BTC-USD')).toBe('BTC-USD');
  });

  it('should truncate to 32 chars', () => {
    const long = 'A'.repeat(50);
    expect(sanitizeForGoogleFinanceSymbol(long).length).toBe(32);
  });

  it('should handle empty input', () => {
    expect(sanitizeForGoogleFinanceSymbol('')).toBe('');
  });
});
