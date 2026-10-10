/**
 * SC-1545. The same defect as `holding-price-update`, one processor over: a
 * refresh for an account or holding that is gone threw a plain Error whose
 * message carried the account's uuid, was retried, and was dead-lettered.
 *
 * The lock and the use case are stubbed: what is under test is what the
 * processor makes of the refusal, and that it still lets go of the lock.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { RecordNotAccessibleError, RefreshAccountBalanceUseCase } from '@scani/domain';
import { HoldingRepository, PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ReconcilePaymentsUseCase } from '@scani/domain/use-cases';
import type { RefreshAccountBalanceJob } from '@scani/jobs';
import {
  BullMqEnqueueService,
  PostgresResourceLock,
  type ProcessorContext,
  UnrecoverableError,
  userFacingMessage,
} from '@scani/queue';
import { Container } from 'typedi';
import { describeRefusedRecord } from '../../src/lib/request-refusal';
import { RefreshAccountBalanceProcessor } from '../../src/processors/refresh-account-balance';

restoreContainerAfterAll();

const JOB: RefreshAccountBalanceJob = {
  userId: 'user-1',
  requestId: 'req-1',
  accountId: 'acct-1',
  holdingId: 'holding-1',
};

const CTX = { job: { id: 'job-1' } } as unknown as ProcessorContext;

class TestableProcessor extends RefreshAccountBalanceProcessor {
  run(data: RefreshAccountBalanceJob) {
    return this.handle(data, CTX);
  }
}

let released = 0;
afterEach(() => {
  released = 0;
});

async function failureOf(error: unknown): Promise<unknown> {
  Container.set(PostgresResourceLock, {
    acquire: async () => ({
      ok: true,
      release: async () => {
        released += 1;
      },
    }),
  } as unknown as PostgresResourceLock);
  Container.set(RefreshAccountBalanceUseCase, {
    execute: async () => {
      throw error;
    },
  } as unknown as RefreshAccountBalanceUseCase);
  try {
    await new TestableProcessor().run(JOB);
  } catch (err) {
    return err;
  }
  throw new Error('expected the processor to throw');
}

describe('RefreshAccountBalanceProcessor error classification', () => {
  test('an account that is gone fails on the first attempt, with no id in the sentence', async () => {
    const err = await failureOf(
      new RecordNotAccessibleError('account', 'Account acct-1 not found or not owned by user')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('account'));
    expect((err as Error).message).not.toContain('acct-1');
    expect(released).toBe(1);
  });

  test('a holding that is gone fails on the first attempt', async () => {
    const err = await failureOf(
      new RecordNotAccessibleError('holding', 'Holding not found or not owned by user')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('holding'));
    expect(released).toBe(1);
  });

  test('CONTROL: a provider that could not be reached keeps its class, so it is still retried', async () => {
    const err = await failureOf(new Error('socket hang up'));
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
    expect(userFacingMessage(err)).toBeNull();
    expect(released).toBe(1);
  });
});

/**
 * SC-1665. A refresh that read the ledger with the balance and wrote rows is
 * followed exactly as an import that wrote them: the chart rebuild is queued
 * and the bills those rows pay are matched.
 */
describe('a refresh whose ledger read wrote rows', () => {
  function refreshWriting(ledger: { transactions: number } | null) {
    const queued: string[] = [];
    const reconciled: string[] = [];
    Container.set(PostgresResourceLock, {
      acquire: async () => ({ ok: true, release: async () => undefined }),
    } as unknown as PostgresResourceLock);
    Container.set(RefreshAccountBalanceUseCase, {
      execute: async () => ({
        accountId: 'acct-1',
        source: 'exchange',
        ledger: ledger && {
          ...ledger,
          source: 'airwallex-api',
          earliestWrittenAt: new Date().toISOString(),
          warnings: [],
          warningDetails: [],
        },
      }),
    } as unknown as RefreshAccountBalanceUseCase);
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
      add: async (descriptor: { name: string }) => {
        queued.push(descriptor.name);
      },
    } as unknown as BullMqEnqueueService);
    Container.set(ReconcilePaymentsUseCase, {
      execute: async (userId: string) => {
        reconciled.push(userId);
        return { scanned: 0, matched: 0 };
      },
    } as unknown as ReconcilePaymentsUseCase);
    return { run: () => new TestableProcessor().run(JOB), queued, reconciled };
  }

  test('rows written: the rebuild is queued and the bills are matched', async () => {
    const { run, queued, reconciled } = refreshWriting({ transactions: 3 });
    await run();
    expect(queued).toEqual(['portfolio-history-backfill']);
    expect(reconciled).toEqual(['user-1']);
  });

  test('control: no ledger read, nothing follows', async () => {
    const { run, queued, reconciled } = refreshWriting(null);
    await run();
    expect(queued).toEqual([]);
    expect(reconciled).toEqual([]);
  });
});
