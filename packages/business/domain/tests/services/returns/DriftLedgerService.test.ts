process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { rawEvidence } from '../../../test/helpers/raw-evidence';

/**
 * The memo is keyed on the handed ledger map, and the answer also depends on
 * which holdings were asked about (SC-1553). Each holding below has one balance
 * reading and no ledger, so each is owed one drift row.
 */

restoreContainerAfterAll();

const reading = { observedAt: new Date('2026-03-02T10:00:00Z'), balance: '100' };

function harness() {
  const readsAskedFor: string[][] = [];
  Container.set(HoldingTransactionRepository, {
    findForHoldingsAll: async () => new Map(),
  } as unknown as HoldingTransactionRepository);
  Container.set(PriceReader, {
    firstReadingAt: async () => new Map(),
  } as unknown as PriceReader);
  Container.set(EngineEvidenceRepository, {
    findHoldingEvidence: async ({ holdingIds }: { holdingIds: string[] }) => {
      readsAskedFor.push([...holdingIds]);
      return holdingIds.map((id) => rawEvidence(id, [reading]));
    },
  } as unknown as EngineEvidenceRepository);
  return { service: new DriftLedgerService(), readsAskedFor };
}

const asked = (...ids: string[]) => new Map(ids.map((id) => [id, `token-${id}`]));
const ledger = (): Map<string, HoldingTransaction[]> =>
  new Map([
    ['h-a', []],
    ['h-b', []],
  ]);

describe('DriftLedgerService memo (SC-1553)', () => {
  test('a holding added to the asked set on a later call with the same map gets its drift rows', async () => {
    const { service } = harness();
    const transactions = ledger();
    await service.forHoldings('u', asked('h-a'), { transactions, tx: undefined });
    const second = await service.forHoldings('u', asked('h-a', 'h-b'), {
      transactions,
      tx: undefined,
    });
    expect([...second.keys()].sort()).toEqual(['h-a', 'h-b']);
  });

  test('a narrower later call answers only the holdings it asked about', async () => {
    const { service } = harness();
    const transactions = ledger();
    await service.forHoldings('u', asked('h-a', 'h-b'), { transactions, tx: undefined });
    const second = await service.forHoldings('u', asked('h-a'), { transactions, tx: undefined });
    expect([...second.keys()]).toEqual(['h-a']);
  });

  test('a later call reads readings only for holdings no earlier call with that map covered', async () => {
    const { service, readsAskedFor } = harness();
    const transactions = ledger();
    await service.forHoldings('u', asked('h-a'), { transactions, tx: undefined });
    await service.forHoldings('u', asked('h-a', 'h-b'), { transactions, tx: undefined });
    expect(readsAskedFor).toEqual([['h-a'], ['h-b']]);
  });

  test('control: a repeated call with the same map and the same holdings reads nothing more', async () => {
    const { service, readsAskedFor } = harness();
    const transactions = ledger();
    const first = await service.forHoldings('u', asked('h-a', 'h-b'), {
      transactions,
      tx: undefined,
    });
    const second = await service.forHoldings('u', asked('h-a', 'h-b'), {
      transactions,
      tx: undefined,
    });
    expect(readsAskedFor).toEqual([['h-a', 'h-b']]);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    expect(second.get('h-b')?.length).toBe(1);
  });
});
