/**
 * SC-1545. A price refresh for a holding that had been deleted threw the use
 * case's plain `Holding not found`, was retried three times against a row
 * that was never coming back, and was then copied to the dead-letter queue.
 *
 * The lock and the use case are stubbed: what is under test is what the
 * processor makes of the refusal, and that it still lets go of the lock.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { RecordNotAccessibleError, UpdateHoldingPriceUseCase } from '@scani/domain';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { HoldingPriceUpdateJob } from '@scani/jobs';
import {
  PostgresResourceLock,
  type ProcessorContext,
  UnrecoverableError,
  userFacingMessage,
} from '@scani/queue';
import { Container } from 'typedi';
import { describeRefusedRecord } from '../../src/lib/request-refusal';
import { HoldingPriceUpdateProcessor } from '../../src/processors/holding-price-update';

restoreContainerAfterAll();

const JOB: HoldingPriceUpdateJob = {
  userId: 'user-1',
  requestId: 'req-1',
  holdingId: 'holding-1',
  priceUsd: 0,
  priceSource: 'manual-refresh',
};

const CTX = { job: { id: 'job-1' } } as unknown as ProcessorContext;

class TestableProcessor extends HoldingPriceUpdateProcessor {
  run(data: HoldingPriceUpdateJob) {
    return this.handle(data, CTX);
  }

  // Reads the user's base currency from the database, which is not the subject.
  protected override async resolveBaseCurrencySymbol(): Promise<string> {
    return 'USD';
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
  Container.set(UpdateHoldingPriceUseCase, {
    execute: async () => {
      throw error;
    },
  } as unknown as UpdateHoldingPriceUseCase);
  try {
    await new TestableProcessor().run(JOB);
  } catch (err) {
    return err;
  }
  throw new Error('expected the processor to throw');
}

describe('HoldingPriceUpdateProcessor error classification', () => {
  test.each([
    ['a holding that is gone', 'Holding not found'],
    ['a holding that is not theirs', 'Unauthorized: Holding does not belong to user'],
  ])('%s fails on the first attempt, in words written for the owner', async (_name, message) => {
    const err = await failureOf(new RecordNotAccessibleError('holding', message));
    // RETRY_FAST allows three attempts; only this class skips the other two.
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('holding'));
    expect(released).toBe(1);
  });

  test('CONTROL: a failed price fetch keeps its class, so it is still retried', async () => {
    const err = await failureOf(new Error('socket hang up'));
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
    expect(userFacingMessage(err)).toBeNull();
    expect(released).toBe(1);
  });
});
