import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * SC-1671. A Home load asks for three return windows at once, and each one read
 * every holding's evidence for its drift rows. Given one shared memo, callers
 * in flight together read each holding once.
 */

restoreContainerAfterAll();

function makeService(options: { failFirst?: boolean } = {}) {
  const reads: string[][] = [];
  Container.set(EngineEvidenceRepository, {
    findHoldingEvidence: async (scope: { holdingIds: readonly string[] }) => {
      reads.push([...scope.holdingIds]);
      await Bun.sleep(5);
      if (options.failFirst && reads.length === 1) throw new Error('evidence read failed');
      return [];
    },
  } as never);
  Container.set(HoldingTransactionRepository, {
    findForHoldingsAll: async () => new Map(),
  } as never);
  Container.set(PriceReader, { firstReadingAt: async () => new Map() } as never);
  return { service: new DriftLedgerService(), reads };
}

const TOKENS = new Map([
  ['h1', 't1'],
  ['h2', 't2'],
]);

type Shared = Map<string, Promise<HoldingTransaction[] | null>>;

describe('DriftLedgerService with a shared memo (SC-1671)', () => {
  test('two callers at once read each holding once', async () => {
    const { service, reads } = makeService();
    const shared: Shared = new Map();
    await Promise.all([
      service.forHoldings('u', TOKENS, { tx: undefined, shared }),
      service.forHoldings('u', TOKENS, { tx: undefined, shared }),
    ]);
    expect(reads).toEqual([['h1', 'h2']]);
  });

  test('control: without a shared memo each caller reads again', async () => {
    const { service, reads } = makeService();
    await Promise.all([
      service.forHoldings('u', TOKENS, { tx: undefined }),
      service.forHoldings('u', TOKENS, { tx: undefined }),
    ]);
    expect(reads).toEqual([
      ['h1', 'h2'],
      ['h1', 'h2'],
    ]);
  });

  test('a caller asking for more holdings reads only those not shared yet', async () => {
    const { service, reads } = makeService();
    const shared: Shared = new Map();
    await service.forHoldings('u', new Map([['h1', 't1']]), { tx: undefined, shared });
    await service.forHoldings('u', TOKENS, { tx: undefined, shared });
    expect(reads).toEqual([['h1'], ['h2']]);
  });

  test('a failed read is not kept for the next caller', async () => {
    const { service, reads } = makeService({ failFirst: true });
    const shared: Shared = new Map();
    await expect(service.forHoldings('u', TOKENS, { tx: undefined, shared })).rejects.toThrow(
      'evidence read failed'
    );
    await service.forHoldings('u', TOKENS, { tx: undefined, shared });
    expect(reads).toEqual([
      ['h1', 'h2'],
      ['h1', 'h2'],
    ]);
  });
});
