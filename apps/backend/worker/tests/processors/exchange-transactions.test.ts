/**
 * SC-1688. The nightly transaction sync fans out one `transaction-import` per
 * account. Its requestId was a fresh `randomUUID()` per target, and that id is
 * part of the child's jobId, so a second attempt of the same run enqueued
 * every import again.
 */

import { describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { SyncExchangeTransactionsUseCase } from '@scani/domain/use-cases';
import { BullMqEnqueueService } from '@scani/queue';
import type { Job } from 'bullmq';
import { Container } from 'typedi';
import { ExchangeTransactionsProcessor } from '../../src/processors/exchange-transactions';

restoreContainerAfterAll();

class TestableProcessor extends ExchangeTransactionsProcessor {
  run(job: Job) {
    return this.handle(job);
  }
}

const TARGETS = ['acct-1', 'acct-2', 'acct-3'].map((accountId) => ({
  userId: `user-of-${accountId}`,
  accountId,
  source: 'kraken-api',
  since: undefined,
  institutionId: 'inst-1',
}));

function wire(failOn?: string) {
  const enqueued: Array<{ accountId: string; requestId: string }> = [];
  Container.set(SyncExchangeTransactionsUseCase, {
    execute: async () => ({
      targets: TARGETS,
      accountsFound: TARGETS.length,
      skippedNoSource: 0,
      fullHistoryTargets: 0,
    }),
  } as unknown as SyncExchangeTransactionsUseCase);
  Container.set(BullMqEnqueueService, {
    add: async (_d: unknown, payload: { accountId: string; requestId: string }) => {
      if (payload.accountId === failOn) throw new Error('store unreachable');
      enqueued.push({ accountId: payload.accountId, requestId: payload.requestId });
      return `job-${payload.accountId}`;
    },
  } as unknown as BullMqEnqueueService);
  return enqueued;
}

const occurrence = (id: string) => ({ id }) as unknown as Job;

describe('ExchangeTransactionsProcessor fan-out (SC-1688)', () => {
  test('a second attempt of the same run asks for the same imports, so they collapse', async () => {
    const enqueued = wire();
    const processor = new TestableProcessor();
    await processor.run(occurrence('repeat:scheduler:nightly:1760054400000'));
    const first = enqueued.splice(0).map((e) => e.requestId);
    await processor.run(occurrence('repeat:scheduler:nightly:1760054400000'));
    const second = enqueued.map((e) => e.requestId);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  test('CONTROL: the next night is a new run and asks for new imports', async () => {
    const enqueued = wire();
    const processor = new TestableProcessor();
    await processor.run(occurrence('repeat:scheduler:nightly:1760054400000'));
    await processor.run(occurrence('repeat:scheduler:nightly:1760140800000'));
    expect(new Set(enqueued.map((e) => e.requestId)).size).toBe(6);
  });

  test('one account failing to enqueue does not fail the run, so nothing is re-sent', async () => {
    const enqueued = wire('acct-2');
    await expect(
      new TestableProcessor().run(occurrence('repeat:scheduler:nightly:1760054400000'))
    ).resolves.toBeUndefined();
    expect(enqueued.map((e) => e.accountId)).toEqual(['acct-1', 'acct-3']);
  });
});
