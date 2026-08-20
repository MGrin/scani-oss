import { describe, expect, test } from 'bun:test';
import { TransactionImportCoordinator, TransactionImportUnrecoverableError } from '@scani/domain';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { TransactionImportJob } from '@scani/jobs';
import { ProviderError } from '@scani/providers/core/errors';
import { type ProcessorContext, UnrecoverableError } from '@scani/queue';
import { Container } from 'typedi';
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

  test('the pre-existing coordinator bridge still works', async () => {
    const err = await failureOf(
      new TransactionImportUnrecoverableError('No stored credentials', 'no-credentials')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('No stored credentials');
  });
});
