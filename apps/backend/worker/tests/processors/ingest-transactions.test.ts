import { describe, expect, test } from 'bun:test';
import { TransactionImportCoordinator, TransactionImportUnrecoverableError } from '@scani/domain';
import { HoldingRepository, PortfolioValueDailyRepository } from '@scani/domain/repositories';
import {
  FeedBatchRejected,
  PortfolioValueCache,
  RecordNotAccessibleError,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ReconcilePaymentsUseCase } from '@scani/domain/use-cases';
import type { TransactionImportJob } from '@scani/jobs';
import { ProviderError } from '@scani/providers/core/errors';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  userFacingMessage,
} from '@scani/queue';
import { Container } from 'typedi';
import { describeRefusedRecord } from '../../src/lib/request-refusal';
import { IngestTransactionsProcessor } from '../../src/processors/ingest-transactions';

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

  // R57. One external id for two rows is refused the same way on every attempt.
  test('a batch naming one external id for two rows fails immediately, and says how many', async () => {
    const detail =
      '1 external id(s) are each sent for more than one asset or source, by 2 entries in all';
    const err = await failureOf(new FeedBatchRejected([{ code: 'duplicate-external-id', detail }]));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe(`feed batch rejected: duplicate-external-id (${detail})`);
  });

  test('the pre-existing coordinator bridge still works', async () => {
    const err = await failureOf(
      new TransactionImportUnrecoverableError('No stored credentials', 'no-credentials')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('No stored credentials');
  });

  // SC-1545. This descriptor allows four attempts, and an account that is gone
  // is gone on each of them.
  test.each([
    ['an account that is gone', 'TransactionImport: account acct-1 not found'],
    [
      'an account that is not theirs',
      'TransactionImport: account acct-1 does not belong to user user-1',
    ],
  ])('%s fails immediately, in words written for the owner', async (_name, domainMessage) => {
    const err = await failureOf(new RecordNotAccessibleError('account', domainMessage));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('account'));
    expect((err as Error).message).not.toContain('acct-1');
  });
});

/**
 * SC-1459. The rebuild an import queues was sized from the snapshot's age
 * alone, so a row written 200 days back into a portfolio snapshotted
 * yesterday rebuilt 8 days and left the other 192 stale.
 */
describe('the rebuild after an import reaches the oldest row it wrote', () => {
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
    Container.set(ReconcilePaymentsUseCase, {
      execute: async () => ({ scanned: 0, matched: 0 }),
    } as unknown as ReconcilePaymentsUseCase);
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

/**
 * SC-1665 Part 4. An expected income that arrives marks its bill paid. The
 * matcher existed and nothing called it, so every bill was settled by hand.
 */
describe("an import that wrote rows reconciles the user's bills", () => {
  function processorImporting(transactions: number, reconcile: () => Promise<unknown>) {
    const reconciled: string[] = [];
    Container.set(TransactionImportCoordinator, {
      execute: async () => ({
        transactions,
        earliestWrittenAt: new Date().toISOString(),
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
      add: async () => undefined,
    } as unknown as BullMqEnqueueService);
    Container.set(PortfolioValueCache, {
      bust: async () => undefined,
    } as unknown as PortfolioValueCache);
    Container.set(ReconcilePaymentsUseCase, {
      execute: async (userId: string) => {
        reconciled.push(userId);
        return reconcile();
      },
    } as unknown as ReconcilePaymentsUseCase);
    return { processor: new TestableProcessor(), reconciled };
  }

  test('rows written: the bills of that user are matched', async () => {
    const { processor, reconciled } = processorImporting(5, async () => ({
      scanned: 1,
      matched: 1,
    }));
    await processor.run(JOB, makeCtx());
    expect(reconciled).toEqual(['user-1']);
  });

  test('control: an import that wrote nothing matches nothing', async () => {
    const { processor, reconciled } = processorImporting(0, async () => ({
      scanned: 0,
      matched: 0,
    }));
    await processor.run(JOB, makeCtx());
    expect(reconciled).toEqual([]);
  });

  test('a failed match does not fail the import, whose rows are already written', async () => {
    const { processor, reconciled } = processorImporting(2, async () => {
      throw new Error('vendor lookup timed out');
    });
    const result = (await processor.run(JOB, makeCtx())) as { transactions: number };
    expect(result.transactions).toBe(2);
    expect(reconciled).toEqual(['user-1']);
  });
});
