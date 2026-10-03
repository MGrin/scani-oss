import { describe, expect, test } from 'bun:test';
import { normalizeKrakenAsset } from '../../../src/providers/kraken/asset-normalizer';

describe('normalizeKrakenAsset', () => {
  // SC-1486: SOL03.S is SOL bonded for staking. As its own token it has no
  // price, so its lots carried cost 0 and the move back to SOL booked the
  // whole balance as a gain.
  test('a numbered lock-up code is its base asset', () => {
    expect(normalizeKrakenAsset('SOL03.S')).toBe('SOL');
    expect(normalizeKrakenAsset('DOT28.S')).toBe('DOT');
    expect(normalizeKrakenAsset('ATOM21.S')).toBe('ATOM');
  });

  test('controls: ordinary codes and digit-bearing tickers are unchanged', () => {
    expect(normalizeKrakenAsset('SOL.S')).toBe('SOL');
    expect(normalizeKrakenAsset('XXBT.F')).toBe('BTC');
    expect(normalizeKrakenAsset('ETH2.S')).toBe('ETH2');
    expect(normalizeKrakenAsset('ETH2')).toBe('ETH2');
    expect(normalizeKrakenAsset('C98')).toBe('C98');
    expect(normalizeKrakenAsset('1INCH')).toBe('1INCH');
    expect(normalizeKrakenAsset('API3')).toBe('API3');
  });
});
