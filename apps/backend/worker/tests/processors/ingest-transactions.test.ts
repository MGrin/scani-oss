import { describe, expect, test } from 'bun:test';
import { TransactionImportCoordinator, TransactionImportUnrecoverableError } from '@scani/domain';
import { HoldingRepository, PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { FeedBatchRejected, PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { TransactionImportJob } from '@scani/jobs';
import { ProviderError } from '@scani/providers/core/errors';
import { BullMqEnqueueService, type ProcessorContext, UnrecoverableError } from '@scani/queue';
import { Container } from 'typedi';
import {
  IngestTransactionsProcessor,
  widenToEarliestWrite,
} from '../../src/processors/ingest-transactions';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-166. Bybit answered `retCode=131002` — a start/end span its endpoint
 * will not serve — to the same request on every attempt, and the import
 * spent its whole retry budget re-sending it. The provider had already said
 * so: `ProviderError.kind` was `'unrecoverable'`, whose own docblock reads
 * "don't retry; surface to the user". Nothing on this path read the field.
 *
 * These pin the classification, not the Bybit specifics — any provider that
 * rejects a request as permanently bad must fail on the first attempt.
 */

const JOB: TransactionImportJob = {
  userId: 'user-1',
  requestId: 'req-1',
  accountId: 'acct-1',
  source: 'bybit-api',
} as TransactionImportJob;

function makeCtx(): ProcessorContext {
  return {
    job: { id: 'job-1' },
    reportProgress: async () => undefined,
    reportStatus: async () => undefined,
  } as unknown as ProcessorContext;
}

class TestableProcessor extends IngestTransactionsProcessor {
  // `handle` is protected on UserJobProcessor; the error classification it
  // performs is the whole subject, so expose it rather than stand BullMQ up.
  run(data: TransactionImportJob, ctx: ProcessorContext) {
    return this.handle(data, ctx);
  }
}

function processorThatFailsWith(error: unknown): TestableProcessor {
  Container.set(TransactionImportCoordinator, {
    execute: async () => {
      throw error;
    },
  } as unknown as TransactionImportCoordinator);
  return new TestableProcessor();
}

async function failureOf(error: unknown): Promise<unknown> {
  try {
    await processorThatFailsWith(error).run(JOB, makeCtx());
  } catch (err) {
    return err;
  }
  throw new Error('expected the processor to throw');
}

describe('IngestTransactionsProcessor error classification', () => {
  test("a provider's `unrecoverable` rejection fails immediately, keeping its message", async () => {
    const err = await failureOf(
      new ProviderError(
        'Bybit retCode=131002: The interval between the startTime and endTime must be less than 30 days',
        'unrecoverable',
        'bybit'
      )
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    // The user reads this string in /jobs, so the provider's own wording has
    // to survive the translation rather than becoming "import failed".
    expect((err as Error).message).toContain('retCode=131002');
  });

  test("a provider's `auth-failed` says what to do about it, and does not retry", async () => {
    const err = await failureOf(new ProviderError('bybit HTTP 401', 'auth-failed', 'bybit'));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/reconnect the integration/i);
  });

  test('`rate-limited` and `retryable` keep their attempts — that is what the budget is for', async () => {
    for (const kind of ['rate-limited', 'retryable'] as const) {
      const err = await failureOf(new ProviderError(`bybit ${kind}`, kind, 'bybit'));
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err).toBeInstanceOf(ProviderError);
    }
  });

  test('a plain Error is still retried — only a classified rejection is terminal', async () => {
    const err = await failureOf(new Error('socket hang up'));
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
  });

  // R38. The feed write refuses a batch before it reads anything, and the same
  // events refuse the same way on every attempt, so retrying spends the budget
  // on a known answer.
  test('a batch the feed write refuses fails immediately, naming every problem', async () => {
    const err = await failureOf(
      new FeedBatchRejected([
        { code: 'empty-external-id', detail: 'entry 2 has an empty external id' },
        { code: 'invalid-date', detail: 'entry 5 occurs at an invalid date' },
      ])
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('empty-external-id');
    expect((err as Error).message).toContain('invalid-date');
  });

  test('the pre-existing coordinator bridge still works', async () => {
    const err = await failureOf(
      new TransactionImportUnrecoverableError('No stored credentials', 'no-credentials')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('No stored credentials');
  });
});

/**
 * SC-1459. The rebuild an import queues was sized from the snapshot's age
 * alone, so a row written 200 days back into a portfolio snapshotted
 * yesterday rebuilt 8 days and left the other 192 stale.
 */
describe('the rebuild after an import reaches the oldest row it wrote', () => {
  const NOW = new Date('2026-09-30T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  test('a row 200 days back widens an 8-day window past it', () => {
    expect(widenToEarliestWrite(8, daysAgo(200), NOW)).toBeGreaterThanOrEqual(200);
  });

  test('an opening balance 547 days back reaches past the 400-day default', () => {
    expect(widenToEarliestWrite(400, daysAgo(547), NOW)).toBeGreaterThanOrEqual(547);
  });

  test('control: an import of recent rows keeps the snapshot window, so an hourly sync stays small', () => {
    expect(widenToEarliestWrite(8, daysAgo(0), NOW)).toBe(8);
    expect(widenToEarliestWrite(8, null, NOW)).toBe(8);
  });

  test('the window is capped at the schema maximum', () => {
    expect(widenToEarliestWrite(8, daysAgo(365 * 200), NOW)).toBe(365 * 100);
  });

  function processorEnqueuing(earliestWrittenAt: string | null) {
    const added: Array<{ requestId: string; lookbackDays: number }> = [];
    Container.set(TransactionImportCoordinator, {
      execute: async () => ({
        transactions: 3,
        earliestWrittenAt,
        warnings: [],
        warningDetails: [],
      }),
    } as unknown as TransactionImportCoordinator);
    Container.set(PortfolioValueDailyRepository, {
      findLatestSnapshotDate: async () =>
        new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    } as unknown as PortfolioValueDailyRepository);
    Container.set(HoldingRepository, {
      hasHoldingCreatedAfter: async () => false,
    } as unknown as HoldingRepository);
    Container.set(BullMqEnqueueService, {
      add: async (_d: unknown, payload: { requestId: string; lookbackDays: number }) => {
        added.push(payload);
      },
    } as unknown as BullMqEnqueueService);
    Container.set(PortfolioValueCache, {
      bust: async () => undefined,
    } as unknown as PortfolioValueCache);
    return { processor: new TestableProcessor(), added };
  }

  test('the queued job carries the widened window under its own id', async () => {
    const earliest = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const { processor, added } = processorEnqueuing(earliest);
    await processor.run(JOB, makeCtx());
    expect(added).toHaveLength(1);
    expect(added[0]?.lookbackDays).toBeGreaterThanOrEqual(200);
    expect(added[0]?.requestId).toMatch(/^tx-import-\d+-\d+d$/);
  });

  test('control: a recent import keeps the bucket id, so a wave still coalesces into one job', async () => {
    const { processor, added } = processorEnqueuing(new Date().toISOString());
    await processor.run(JOB, makeCtx());
    expect(added[0]?.lookbackDays).toBeLessThan(30);
    expect(added[0]?.requestId).toMatch(/^tx-import-\d+$/);
  });
});
