import { describe, expect, test } from 'bun:test';
import { assetClassOf } from '../../src/engine/price-at';
import {
  CUSTOM_TOKEN_TYPE_CODES,
  VALUED_ASSET_TYPE_CODES,
} from '../../src/lib/custom-token-visibility';

describe('valued asset types are custom (SC-1643)', () => {
  test.each(['property', 'vehicle'])('%s prices as a custom token', (code) => {
    expect(assetClassOf(code)).toBe('custom');
  });

  test('every custom type code is a custom asset class', () => {
    for (const code of CUSTOM_TOKEN_TYPE_CODES) expect(assetClassOf(code)).toBe('custom');
  });

  test('the valued asset types are custom token types', () => {
    expect(VALUED_ASSET_TYPE_CODES).toEqual(['property', 'vehicle']);
    for (const code of VALUED_ASSET_TYPE_CODES) expect(CUSTOM_TOKEN_TYPE_CODES).toContain(code);
  });
});
