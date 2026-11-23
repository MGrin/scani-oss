import { expect, test } from 'bun:test';
import { priceAt } from '../../src/engine/price-at';
import type { PriceEvidence } from '../../src/engine/types';

const start = new Date('2026-01-01T00:00:00Z');
const hour = 3_600_000;
const evidence: PriceEvidence = {
  hubTokenIds: ['USD'],
  assetClasses: new Map([['USD', 'fiat']]),
  readings: [
    {
      tokenId: 'X',
      baseTokenId: 'USD',
      at: start,
      price: '10',
      source: 'manual',
      granularity: 'intraday',
    },
    {
      tokenId: 'USD',
      baseTokenId: 'EUR',
      at: new Date(+start + hour),
      price: '2',
      source: 'fx',
      granularity: 'intraday',
    },
  ],
};

test('deadline uses every route leg horizon, even when its reading is not the oldest', () => {
  const deadline = new Date(+start + 121 * hour);
  const asset = { tokenId: 'X', assetClass: 'custom' } as const;
  const answer = priceAt(evidence, asset, 'EUR', deadline);
  expect(answer?.staleAfter).toEqual(deadline);
  expect(answer?.stale).toBe(false);
  expect(priceAt(evidence, asset, 'EUR', new Date(+deadline + 1))?.stale).toBe(true);
  expect(
    priceAt(evidence, { ...asset, assetClass: 'crypto' }, 'EUR', deadline)?.staleAfter
  ).toEqual(new Date(+start + 48 * hour));
});

test('identity and a direct custom step never expire', () => {
  expect(
    priceAt(evidence, { tokenId: 'EUR', assetClass: 'fiat' }, 'EUR', start)?.staleAfter
  ).toBeNull();
  expect(
    priceAt(evidence, { tokenId: 'X', assetClass: 'custom' }, 'USD', start)?.staleAfter
  ).toBeNull();
});
