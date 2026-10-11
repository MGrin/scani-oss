/**
 * SC-1665. The hourly exchange sync reads each account's ledger with its
 * balance; every account whose read wrote rows is followed as an import is.
 */

import { describe, expect, test } from 'bun:test';
import { HoldingRepository, PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ReconcilePaymentsUseCase, SyncExchangeBalancesUseCase } from '@scani/domain/use-cases';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { ExchangeBalancesProcessor } from '../../src/processors/exchange-balances';

restoreContainerAfterAll();

class TestableProcessor extends ExchangeBalancesProcessor {
  run() {
    return this.handle();
  }
}

function syncWriting(ledgerWrites: Array<{ userId: string; accountId: string }>) {
  const queued: string[] = [];
  const reconciled: string[] = [];
  Container.set(SyncExchangeBalancesUseCase, {
    execute: async () => ({
      accountsSynced: ledgerWrites.length,
      accountsFailed: 0,
      holdingsCreated: 0,
      holdingsUpdated: 0,
      holdingsRemoved: 0,
      errors: [],
      ledgerWrites: ledgerWrites.map((w) => ({
        ...w,
        result: {
          source: 'kraken-api',
          transactions: 2,
          earliestWrittenAt: new Date().toISOString(),
          warnings: [],
          warningDetails: [],
        },
      })),
    }),
  } as unknown as SyncExchangeBalancesUseCase);
  Container.set(PortfolioValueCache, {
    bust: async () => undefined,
  } as unknown as PortfolioValueCache);
  Container.set(PortfolioValueDailyRepository, {
    findLatestSnapshotDate: async () =>
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  } as unknown as PortfolioValueDailyRepository);
  Container.set(HoldingRepository, {
    hasHoldingCreatedAfter: async () => false,
  } as unknown as HoldingRepository);
  Container.set(BullMqEnqueueService, {
    add: async (_d: unknown, payload: { userId: string }) => {
      queued.push(payload.userId);
    },
  } as unknown as BullMqEnqueueService);
  Container.set(ReconcilePaymentsUseCase, {
    execute: async (userId: string) => {
      reconciled.push(userId);
      return { scanned: 0, matched: 0 };
    },
  } as unknown as ReconcilePaymentsUseCase);
  return { run: () => new TestableProcessor().run(), queued, reconciled };
}

describe('ExchangeBalancesProcessor follows each ledger write', () => {
  test('every account that wrote rows queues its rebuild and matches its bills', async () => {
    const { run, queued, reconciled } = syncWriting([
      { userId: 'user-1', accountId: 'acct-1' },
      { userId: 'user-2', accountId: 'acct-2' },
    ]);
    await run();
    expect(queued.sort()).toEqual(['user-1', 'user-2']);
    expect(reconciled.sort()).toEqual(['user-1', 'user-2']);
  });

  test('control: a run with no ledger writes follows nothing', async () => {
    const { run, queued, reconciled } = syncWriting([]);
    await run();
    expect(queued).toEqual([]);
    expect(reconciled).toEqual([]);
  });
});
