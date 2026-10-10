process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';
import { rawEvidence } from '../../../test/helpers/raw-evidence';

/**
 * mgrin, 2026-10-01: a balance change no transaction explains is money in or
 * out, never return — unless the owner answered that it was growth (SC-1470).
 * The money side is where that decision lands, so it is asserted here against
 * the real `DriftLedgerService`, with only the repositories stubbed.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const HOLDING = 'h-1';
const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-12-31T00:00:00Z');

const reading = (observedAt: string, balance: string, gapReview: string | null = null) => ({
  holdingId: HOLDING,
  observedAt: new Date(observedAt),
  balance,
  gapReview,
});

function makeService(readings: ReturnType<typeof reading>[], isActive = true): ExternalFlowService {
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async () => [],
    findForHoldingsAll: async () => new Map([[HOLDING, []]]),
  } as unknown as HoldingTransactionRepository);
  Container.set(EngineEvidenceRepository, {
    findHoldingEvidence: async () => [rawEvidence(HOLDING, readings)],
  } as unknown as EngineEvidenceRepository);
  Container.set(HoldingRepository, {
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findByIds: async () => [{ id: HOLDING, tokenId: USD, userId: 'u', isActive }],
  } as unknown as HoldingRepository);
  Container.set(
    PriceReader,
    priceReaderStub((amount: Decimal) => ({ amount: new Decimal(amount), stale: false }))
  );
  Container.set(DriftLedgerService, new DriftLedgerService());
  return new ExternalFlowService();
}

const SCOPE = [{ holdingId: HOLDING, weight: new Decimal(1) }];
const total = (flows: { baseAmount: string }[]) =>
  flows.reduce((sum, f) => sum.add(f.baseAmount), new Decimal(0)).toString();

describe('ExternalFlowService — an unexplained balance change (SC-1470)', () => {
  test('an unanswered fall is money out, and a holding with no ledger arrived as money in', async () => {
    const series = await makeService([
      reading('2026-03-02T10:00:00Z', '41648.49'),
      reading('2026-05-02T10:00:00Z', '22379.37'),
    ]).forHoldings(SCOPE, USD, FROM, TO);
    expect(total(series.flows)).toBe('22379.37');
    expect(series.flows.filter((f) => f.kind === 'drift_in').length).toBe(1);
    expect(total(series.flows.filter((f) => f.kind === 'drift_out'))).toBe('-19269.12');
  });

  test('"unknown" is still money in or out', async () => {
    const series = await makeService([
      reading('2026-03-02T10:00:00Z', '100'),
      reading('2026-03-02T20:00:00Z', '150', 'unknown'),
    ]).forHoldings(SCOPE, USD, FROM, TO);
    expect(total(series.flows)).toBe('150');
  });

  test('a rise the owner answered growth is return, so only the arrival crosses the boundary', async () => {
    const series = await makeService([
      reading('2026-03-02T10:00:00Z', '100'),
      reading('2026-03-02T20:00:00Z', '150', 'growth'),
    ]).forHoldings(SCOPE, USD, FROM, TO);
    expect(total(series.flows)).toBe('100');
  });

  test('an inactive holding is never valued (SC-1328), so it books no drift either', async () => {
    const series = await makeService([reading('2026-09-06T04:25:45Z', '444')], false).forHoldings(
      SCOPE,
      USD,
      FROM,
      TO
    );
    expect(series.flows).toHaveLength(0);
  });

  test('control: a change outside the window is not counted in it', async () => {
    const series = await makeService([
      reading('2025-03-02T10:00:00Z', '100'),
      reading('2025-06-02T10:00:00Z', '40'),
    ]).forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows).toHaveLength(0);
  });
});
