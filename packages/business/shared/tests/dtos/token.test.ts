import { describe, expect, test } from 'bun:test';
import { CreateCustomTokenDto, CreateTokenDto, UpdateCustomPriceDto } from '../../src/dtos/token';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

describe('CreateTokenDto', () => {
  test('accepts a minimal payload (just symbol)', () => {
    const result = CreateTokenDto.safeParse({ symbol: 'btc' });
    expect(result.success).toBe(true);
  });

  test('uppercases symbol via transform', () => {
    const result = CreateTokenDto.safeParse({ symbol: 'btc' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.symbol).toBe('BTC');
  });

  /**
   * DELETED, not retargeted: this asserted `decimals` defaults to 2, and that
   * capability was removed rather than moved. SC-544 — a caller who supplied no
   * decimals has said nothing, and `.default(2)` turned that silence into a
   * claim. It is `typeCode === 'crypto' ? 18 : 2` wearing a zod default, and it
   * put a number on 20 production rows that no source ever produced.
   *
   * Re-adding a default here has to delete this comment first.
   */
  test('leaves decimals absent rather than defaulting it, and still defaults isActive', () => {
    const result = CreateTokenDto.safeParse({ symbol: 'BTC' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.decimals).toBeUndefined();
    expect(result.data.isActive).toBe(true);
  });

  test('still accepts a decimals the caller does supply', () => {
    // The user IS the authority for a token they created: there is no chain and
    // no standard for a custom asset, so refusing their value would leave the
    // one class where the answer is knowable permanently NULL. It is recorded
    // with authority `user`.
    const result = CreateTokenDto.safeParse({ symbol: 'BTC', decimals: 8 });
    if (!result.success) throw new Error('expected success');
    expect(result.data.decimals).toBe(8);
  });

  test('accepts all optional fields including provider metadata', () => {
    expect(
      CreateTokenDto.safeParse({
        symbol: 'BTC',
        name: 'Bitcoin',
        typeId: VALID_UUID,
        decimals: 8,
        iconUrl: 'https://example.com/btc.png',
        coinGeckoId: 'bitcoin',
        providerMetadata: {
          provider: 'coingecko',
          coingecko: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
          validatedAt: '2026-01-01T00:00:00Z',
        },
      }).success
    ).toBe(true);
  });

  test('rejects empty symbol', () => {
    expect(CreateTokenDto.safeParse({ symbol: '' }).success).toBe(false);
  });

  test('rejects symbol over 20 chars', () => {
    expect(CreateTokenDto.safeParse({ symbol: 'A'.repeat(21) }).success).toBe(false);
  });

  test('rejects decimals out of range (0..18)', () => {
    expect(CreateTokenDto.safeParse({ symbol: 'BTC', decimals: -1 }).success).toBe(false);
    expect(CreateTokenDto.safeParse({ symbol: 'BTC', decimals: 19 }).success).toBe(false);
  });

  test('rejects non-positive manualPrice', () => {
    expect(CreateTokenDto.safeParse({ symbol: 'X', manualPrice: 0 }).success).toBe(false);
    expect(CreateTokenDto.safeParse({ symbol: 'X', manualPrice: -1 }).success).toBe(false);
  });

  test('rejects unknown provider in providerMetadata', () => {
    expect(
      CreateTokenDto.safeParse({
        symbol: 'X',
        providerMetadata: { provider: 'bogus' as never },
      }).success
    ).toBe(false);
  });
});

describe('CreateCustomTokenDto', () => {
  const base = {
    symbol: 'PRIV',
    name: 'Private Token',
    typeCode: 'private-company' as const,
    manualPrice: 100.5,
    baseCurrencyCode: 'usd',
  };

  test('accepts a well-formed payload', () => {
    expect(CreateCustomTokenDto.safeParse(base).success).toBe(true);
  });

  test('uppercases symbol AND baseCurrencyCode', () => {
    const result = CreateCustomTokenDto.safeParse({ ...base, symbol: 'priv' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.symbol).toBe('PRIV');
    expect(result.data.baseCurrencyCode).toBe('USD');
  });

  test('rejects typeCode outside allowed enum', () => {
    expect(CreateCustomTokenDto.safeParse({ ...base, typeCode: 'crypto' as never }).success).toBe(
      false
    );
  });

  test('accepts both private-company and other typeCode', () => {
    expect(CreateCustomTokenDto.safeParse({ ...base, typeCode: 'other' }).success).toBe(true);
  });

  test('rejects non-positive manualPrice', () => {
    expect(CreateCustomTokenDto.safeParse({ ...base, manualPrice: 0 }).success).toBe(false);
    expect(CreateCustomTokenDto.safeParse({ ...base, manualPrice: -1 }).success).toBe(false);
  });

  test('rejects empty baseCurrencyCode', () => {
    expect(CreateCustomTokenDto.safeParse({ ...base, baseCurrencyCode: '' }).success).toBe(false);
  });

  test('rejects baseCurrencyCode over 10 chars', () => {
    expect(
      CreateCustomTokenDto.safeParse({ ...base, baseCurrencyCode: 'TOOLONG1234' }).success
    ).toBe(false);
  });

  test('rejects priceDescription over 500 chars', () => {
    expect(
      CreateCustomTokenDto.safeParse({ ...base, priceDescription: 'a'.repeat(501) }).success
    ).toBe(false);
  });

  test('rejects description over 2000 chars', () => {
    expect(CreateCustomTokenDto.safeParse({ ...base, description: 'a'.repeat(2001) }).success).toBe(
      false
    );
  });

  test('rejects non-URL iconUrl', () => {
    expect(CreateCustomTokenDto.safeParse({ ...base, iconUrl: 'not-a-url' }).success).toBe(false);
  });
});

describe('UpdateCustomPriceDto', () => {
  test('accepts a well-formed payload', () => {
    expect(
      UpdateCustomPriceDto.safeParse({
        tokenId: VALID_UUID,
        newPrice: 123.45,
        baseCurrencyCode: 'usd',
        reason: 'Quarterly valuation',
      }).success
    ).toBe(true);
  });

  test('uppercases baseCurrencyCode', () => {
    const result = UpdateCustomPriceDto.safeParse({
      tokenId: VALID_UUID,
      newPrice: 1,
      baseCurrencyCode: 'eur',
    });
    if (!result.success) throw new Error('expected success');
    expect(result.data.baseCurrencyCode).toBe('EUR');
  });

  test('rejects non-uuid tokenId', () => {
    expect(
      UpdateCustomPriceDto.safeParse({
        tokenId: 'not-a-uuid',
        newPrice: 1,
        baseCurrencyCode: 'USD',
      }).success
    ).toBe(false);
  });

  test('rejects non-positive newPrice', () => {
    expect(
      UpdateCustomPriceDto.safeParse({
        tokenId: VALID_UUID,
        newPrice: 0,
        baseCurrencyCode: 'USD',
      }).success
    ).toBe(false);
  });

  test('rejects empty reason when present', () => {
    expect(
      UpdateCustomPriceDto.safeParse({
        tokenId: VALID_UUID,
        newPrice: 1,
        baseCurrencyCode: 'USD',
        reason: '',
      }).success
    ).toBe(false);
  });
});
