/**
 * The pairing rules, tested as the pure functions they are (SC-336).
 *
 * The negative cases carry the weight here. A bridge pair is recognised from
 * two legs on two chains, and the ways that shape can be counterfeited —
 * a symbol collision, a wrapper, an arrival that precedes its departure — are
 * each a way to merge two unrelated lot chains, which is worse than the gap
 * the rule exists to close.
 */

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { candidatePairClass, type TransferLeg } from '../../src/lib/transfer-matching';

const T0 = new Date('2026-03-14T08:36:35.000Z');

function leg(over: Partial<TransferLeg> = {}): TransferLeg {
  return {
    transactionId: 'tx-1',
    holdingId: 'holding-a',
    tokenId: 'token-usdc-ethereum',
    canonicalAssetKey: 'usd-coin',
    walletId: 'wallet-1',
    chainKey: '1',
    occurredAt: T0,
    quantityAbs: new Decimal('100'),
    ...over,
  };
}

const arrival = (over: Partial<TransferLeg> = {}): TransferLeg =>
  leg({
    transactionId: 'tx-2',
    holdingId: 'holding-b',
    tokenId: 'token-usdc-base',
    chainKey: '8453',
    occurredAt: new Date(T0.getTime() + 6_000),
    quantityAbs: new Decimal('99.987151'),
    ...over,
  });

describe('candidatePairClass', () => {
  test('two legs on the same token row are a same_token pair', () => {
    expect(candidatePairClass(leg(), leg({ transactionId: 'tx-2', holdingId: 'holding-b' }))).toBe(
      'same_token'
    );
  });

  test('the same asset on two chains, one wallet, is a bridged_asset pair', () => {
    expect(candidatePairClass(leg(), arrival())).toBe('bridged_asset');
  });

  test('refuses two different assets that merely share a symbol', () => {
    // The memecoin case: a token row calling itself USDC that no external
    // authority has ever heard of. No key, so nothing to compare.
    expect(candidatePairClass(leg(), arrival({ canonicalAssetKey: null }))).toBeNull();
    expect(candidatePairClass(leg({ canonicalAssetKey: null }), arrival())).toBeNull();
    expect(
      candidatePairClass(leg({ canonicalAssetKey: null }), arrival({ canonicalAssetKey: null }))
    ).toBeNull();
  });

  test('refuses WETH against ETH — a wrapper is a different asset', () => {
    expect(
      candidatePairClass(
        leg({ canonicalAssetKey: 'weth' }),
        arrival({ canonicalAssetKey: 'ethereum' })
      )
    ).toBeNull();
  });

  test('refuses an arrival that precedes its departure', () => {
    expect(
      candidatePairClass(leg(), arrival({ occurredAt: new Date(T0.getTime() - 1) }))
    ).toBeNull();
  });

  test('refuses two chains when the wallet is not the same one', () => {
    expect(candidatePairClass(leg(), arrival({ walletId: 'wallet-2' }))).toBeNull();
    expect(candidatePairClass(leg(), arrival({ walletId: null }))).toBeNull();
    expect(candidatePairClass(leg({ walletId: null }), arrival({ walletId: null }))).toBeNull();
  });

  test('refuses two token rows on the SAME chain — that is a wrap, not a bridge', () => {
    expect(candidatePairClass(leg(), arrival({ chainKey: '1' }))).toBeNull();
  });

  test('refuses a leg with no chain at all — an exchange has no bridge', () => {
    expect(candidatePairClass(leg({ chainKey: null }), arrival())).toBeNull();
    expect(candidatePairClass(leg(), arrival({ chainKey: null }))).toBeNull();
  });

  test('refuses a pair that resolves to one holding', () => {
    expect(
      candidatePairClass(leg(), arrival({ holdingId: 'holding-a', tokenId: 'token-x' }))
    ).toBeNull();
  });

  test('refuses one holding on the SAME token row, which is the shape that got made', () => {
    ***REMOVED***
    // unrelated events. `same_token` returned before the holding was ever
    // looked at, so the condition this file already tested applied to bridges
    // alone — and every same-holding group in production is a same_token pair.
    expect(candidatePairClass(leg(), leg({ transactionId: 'tx-2' }))).toBeNull();
  });
});
