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
import {
  type ArrivalPart,
  arrivalCombinations,
  candidatePairClass,
  reviewPairClass,
  type TransferLeg,
} from '../../src/lib/transfer-matching';

const T0 = new Date('2026-03-14T08:36:35.000Z');

function leg(over: Partial<TransferLeg> = {}): TransferLeg {
  return {
    transactionId: 'tx-1',
    holdingId: 'holding-a',
    tokenId: 'token-usdc-ethereum',
    canonicalAssetKey: 'usd-coin',
    walletId: 'wallet-1',
    chainKey: '1',
    entityId: null,
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
    expect(candidatePairClass(leg(), leg({ transactionId: 'tx-2' }))).toBeNull();
  });
});

/**
 * The ownership boundary (SC-463).
 *
 * Money crossing between the owner's books and their limited company's is a
 * real event on both — a director's loan, a dividend, a salary. Pairing it
 * carries the lot basis across intact and realizes nothing, which is the wrong
 * answer on both sides at once.
 *
 * **Every refusal here is paired with a must-be-found control** — the same two
 * legs differing only in entity, expected to pair. Without it a predicate that
 * refused everything would pass this whole block, which is the one way a guard
 * can look strongest exactly when it has stopped discriminating.
 */
describe('candidatePairClass — the entity boundary', () => {
  const PERSONAL = 'entity-personal';
  const COMPANY = 'entity-company';

  test('refuses a same-token movement across the boundary', () => {
    const out = leg({ entityId: PERSONAL });
    const inflow = leg({ transactionId: 'tx-2', holdingId: 'holding-b', entityId: COMPANY });

    expect(candidatePairClass(out, inflow)).toBeNull();
    // Control: the identical pair inside ONE set of books still pairs.
    expect(candidatePairClass(out, { ...inflow, entityId: PERSONAL })).toBe('same_token');
  });

  test('refuses a bridge across the boundary', () => {
    const out = leg({ entityId: PERSONAL });
    const inflow = arrival({ entityId: COMPANY });

    expect(candidatePairClass(out, inflow)).toBeNull();
    expect(candidatePairClass(out, { ...inflow, entityId: PERSONAL })).toBe('bridged_asset');
  });

  /**
   * The direction that would otherwise leak. An account nobody has classified
   * is not "wherever the other leg is" — it is outside every boundary, and a
   * movement between the two crosses one.
   */
  test('refuses assigned-to-unassigned in both directions', () => {
    const assigned = leg({ entityId: COMPANY });
    const unassigned = leg({ transactionId: 'tx-2', holdingId: 'holding-b', entityId: null });

    expect(candidatePairClass(assigned, unassigned)).toBeNull();
    expect(candidatePairClass({ ...unassigned, transactionId: 'tx-3' }, assigned)).toBeNull();
    // Control, and the one that matters most: null matches null, so nothing
    // changes for a portfolio whose owner has drawn no boundary — which is
    // every portfolio until they draw one. If this went red the feature would
    // be silently unpairing every existing user's transfers.
    expect(candidatePairClass(leg(), unassigned)).toBe('same_token');
  });
});

/**
 * The same boundary, for a pair a person is choosing (SC-1364). Only the
 * unattended predicate keeps it; the review queue's did too, and offered a
 * company-to-personal transfer nothing but the answer that writes a second
 * arrival.
 */
describe('reviewPairClass — no entity boundary, every other rule', () => {
  test('pairs across the boundary where the unattended predicate refuses', () => {
    const out = leg({ entityId: 'entity-company' });
    const inflow = leg({ transactionId: 'tx-2', holdingId: 'holding-b', entityId: null });

    expect(reviewPairClass(out, inflow)).toBe('same_token');
    expect(candidatePairClass(out, inflow)).toBeNull();
  });

  test('still refuses one holding, and a bridge arriving before it left', () => {
    const out = leg({ entityId: 'entity-company' });

    expect(reviewPairClass(out, leg({ transactionId: 'tx-2', entityId: null }))).toBeNull();
    const early = arrival({ entityId: null, occurredAt: new Date(T0.getTime() - 60_000) });
    expect(reviewPairClass(out, early)).toBeNull();
    // Control: the same bridge arriving after it left pairs.
    expect(reviewPairClass(out, arrival({ entityId: null }))).toBe('bridged_asset');
  });
});

describe('arrivalCombinations — money that landed in parts (SC-1365)', () => {
  const out = { quantityAbs: new Decimal('4000'), occurredAt: T0 };
  const part = (id: string, qty: string, minutes: number, holdingId = 'revolut'): ArrivalPart => ({
    transactionId: id,
    holdingId,
    quantityAbs: new Decimal(qty),
    occurredAt: new Date(T0.getTime() + minutes * 60_000),
  });
  const ids = (found: ArrivalPart[][]) => found.map((c) => c.map((p) => p.transactionId));

  test('finds 3,000 + 1,000 on one holding', () => {
    expect(ids(arrivalCombinations(out, [part('a', '3000', 11), part('b', '1000', 800)]))).toEqual([
      ['a', 'b'],
    ]);
  });

  test('does not combine parts on two different holdings', () => {
    const found = arrivalCombinations(out, [part('a', '3000', 11), part('b', '1000', 20, 'wise')]);
    expect(found).toEqual([]);
  });

  test('ignores a part that landed before the withdrawal, and one that is the whole amount', () => {
    expect(arrivalCombinations(out, [part('a', '3000', -5), part('b', '1000', 20)])).toEqual([]);
    expect(
      arrivalCombinations(out, [part('a', '4000', 5), part('b', '1000', 20), part('c', '3000', 30)])
    ).toHaveLength(1);
  });

  test('ranks the closest total first and caps the parts at three', () => {
    const found = arrivalCombinations(out, [
      part('a', '2000', 1),
      part('b', '1000', 2),
      part('c', '1000', 3),
      part('d', '1900', 4),
    ]);
    expect(ids(found)[0]).toEqual(['a', 'b', 'c']);
    expect(found.every((c) => c.length <= 3)).toBe(true);
  });
});
