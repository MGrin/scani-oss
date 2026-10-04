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
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { RefreshAccountBalanceJob } from '@scani/jobs';
import {
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
