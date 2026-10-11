import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import type { PriceAsk } from '../../../src/engine/types';
import { valuationInstantsOf } from '../../../src/lib/tx-valuation';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceReader, type PriceSeries } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { type StubConvert, seriesFrom } from '../../../test/helpers/price-series';
import { BNB, BTC, EUR, row, USD } from './fixtures/zero-fee-ledger';

/**
 * Cost basis reads its prices from one series (foundation A3, Task 21): loaded
 * once over the instants `valuationInstantsOf` lists, or handed in. The
 * instants are D-10's and do not move.
 */

restoreContainerAfterAll();

const NOW = new Date('2026-09-30T12:00:00Z');
const RATES: Readonly<Record<string, string>> = { [BTC]: '100', [EUR]: '1.1', [BNB]: '300' };
const rates: StubConvert = (amount, from) => {
  const rate = RATES[from];
  return rate ? { amount: amount.mul(rate), stale: false } : null;
};

/** A reader recording every load, and every price asked of what it loaded. */
function recordingReader() {
  const loads: PriceAsk[][] = [];
  const asked: string[] = [];
  const reader = {
    series: async (asks: readonly PriceAsk[], baseTokenId: string): Promise<PriceSeries> => {
      loads.push([...asks]);
      return recorded(seriesFrom(asks, baseTokenId, rates), asked);
    },
  } as unknown as PriceReader;
  return { reader, loads, asked };
}

function recorded(series: PriceSeries, asked: string[]): PriceSeries {
  return {
    priceAt: (tokenId, at) => {
      asked.push(`${tokenId}@${at.toISOString()}`);
      return series.priceAt(tokenId, at);
    },
    fingerprint: series.fingerprint,
  };
}

function service(reader: PriceReader): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceReader, reader);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

function walk(svc: CostBasisService, rows: HoldingTransaction[], prices?: PriceSeries) {
  return svc.walkLots(
    undefined,
    rows,
    USD,
    BTC,
    prices,
    'complete',
    undefined,
    'fifo',
    undefined,
    NOW
  );
}

describe('cost basis reads one series', () => {
  test('a flow is valued at the end of its UTC day, from the series', async () => {
    const { reader, loads, asked } = recordingReader();
    const result = await walk(service(reader), [
      row('d', {
        holdingId: 'A',
        kind: 'deposit',
        quantity: '2',
        occurredAt: '2026-09-10T10:28:00Z',
      }),
    ]);
    expect(loads).toHaveLength(1);
    expect(asked).toEqual([`${BTC}@2026-09-10T23:59:59.999Z`]);
    expect(result.costBasis.toString()).toBe('200');
  });

  test('CONTROL: a trade executed in the base ignores the series', async () => {
    const { reader, loads, asked } = recordingReader();
    const result = await walk(service(reader), [
      row('b', {
        holdingId: 'A',
        kind: 'buy',
        quantity: '2',
        occurredAt: '2026-09-10T10:28:00Z',
        priceNative: '95',
        priceNativeTokenId: USD,
      }),
    ]);
    expect(loads).toEqual([[]]);
    expect(asked).toEqual([]);
    expect(result.costBasis.toString()).toBe('190');
  });

  test('a trade executed in another currency reads the series at the trade’s own instant', async () => {
    const { reader, asked } = recordingReader();
    const result = await walk(service(reader), [
      row('b', {
        holdingId: 'A',
        kind: 'buy',
        quantity: '2',
        occurredAt: '2026-09-10T10:28:00Z',
        priceNative: '90',
        priceNativeTokenId: EUR,
      }),
    ]);
    expect(asked).toEqual([`${EUR}@2026-09-10T10:28:00.000Z`]);
    expect(result.costBasis.toString()).toBe('198');
  });

  test('a fee in a third token reads the series at the row’s own instant', async () => {
    const { reader, asked } = recordingReader();
    const result = await walk(service(reader), [
      row('b', {
        holdingId: 'A',
        kind: 'buy',
        quantity: '2',
        occurredAt: '2026-09-10T10:28:00Z',
        priceNative: '100',
        priceNativeTokenId: USD,
        feeQuantity: '-0.01',
        feeTokenId: BNB,
      }),
    ]);
    expect(asked).toEqual([`${BNB}@2026-09-10T10:28:00.000Z`]);
    expect(result.costBasis.toString()).toBe('203');
  });

  test('a trade priced in a third token is valued from a handed series, with no load', async () => {
    const { reader, loads } = recordingReader();
    const rows = [
      row('b', {
        holdingId: 'A',
        kind: 'buy',
        quantity: '2',
        occurredAt: '2026-09-10T10:28:00Z',
        priceNative: '90',
        priceNativeTokenId: EUR,
      }),
    ];
    const handed = seriesFrom(
      rows.flatMap((r) => valuationInstantsOf(r, USD, BTC, NOW)),
      USD,
      rates
    );
    const result = await walk(service(reader), rows, handed);
    expect(loads).toHaveLength(0);
    expect(result.costBasis.toString()).toBe('198');
  });

  test('cost basis handed no series makes one load for 200 rows', async () => {
    const { reader, loads, asked } = recordingReader();
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(`d${i}`, {
        holdingId: 'A',
        kind: 'deposit',
        quantity: '1',
        occurredAt: new Date(Date.UTC(2026, 0, 1 + i, 10)).toISOString(),
      })
    );
    const result = await walk(service(reader), rows);
    expect(loads).toHaveLength(1);
    expect(loads[0]).toHaveLength(200);
    expect(asked).toHaveLength(200);
    expect(result.costBasis.toString()).toBe('20000');
  });
});
