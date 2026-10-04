import { describe, expect, it, mock } from 'bun:test';
import { ImportTargetGoneError, IntegrationCredentialsService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ImportExchangeAccountsUseCase, ImportIbkrAccountsUseCase } from '@scani/domain/use-cases';
import type { ExchangeImportJob } from '@scani/jobs';
import { IbkrProvider } from '@scani/providers/providers/ibkr';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  userFacingMessage,
} from '@scani/queue';
import { Container } from 'typedi';
import {
  __test_markCredentialFailed,
  __test_isUnrecoverableExchangeError as classify,
  ExchangeImportProcessor,
} from '../../src/processors/exchange-import';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

describe('isUnrecoverableExchangeError', () => {
  it('classifies IBKR Flex bad-token codes', () => {
    expect(classify(new Error('IBKR Flex Query error (code 1010): Invalid token'))).toBe(true);
    expect(classify(new Error('IBKR Flex Query error (code 1012): Expired token'))).toBe(true);
    expect(classify(new Error('IBKR Flex Query error (code 1018): Too many requests'))).toBe(true);
    expect(classify(new Error('IBKR Flex Query error (code 1014): Query is invalid.'))).toBe(true);
    expect(classify(new Error('IBKR Flex Query error (code 1015): Token is invalid.'))).toBe(true);
    // The lockout: each retry is another failed attempt against IBKR's counter.
    expect(classify(new Error('IBKR Flex Query error (code 1025): Too many failed'))).toBe(true);
  });

  it('leaves IBKR poll exhaustion alone so the descriptor budget can retry it', () => {
    // Reversed in SC-443. The rationale on record was that surviving the
    // provider's ~5-minute poll means the Flex template is structurally too
    // heavy or IBKR's queue is stuck, so a BullMQ retry only re-issues
    // SendRequest and deepens the backlog — terminal, so the user narrows the
    // query. Two things undo it.
    //
    // The cause is asserted, not observed: nothing here can tell "the template
    // is too heavy" from "IBKR was slow once", and production has never
    // produced an instance to weigh — measured 2026-08-19, no `user_jobs` row
    // in three months carries any IBKR Flex code and the single live IBKR
    // credential has `sync_failure_count = 0`. And the user was told "this
    // failed for a reason another attempt will not fix. Check the details
    // below, correct them, and start it again" about a report that was merely
    // slow, which names no detail they could correct.
    //
    // So the speculative cost is a deeper backlog and the certain cost is a
    // false instruction. `RETRY_EXTERNAL` bounds the downside at 3 attempts,
    // and a genuine lockout still lands on 1025's own 24h window.
    expect(
      classify(new Error('IBKR report still generating after 24 retries (last: code 1001: busy)'))
    ).toBe(false);
    expect(
      classify(
        new Error('IBKR SendRequest still transient after 6 retries (last: code 1019: queued)')
      )
    ).toBe(false);
    // 1001/1019 no longer reach `classifyFlexError` at all — the poll loops
    // own them end to end — so the raw-code form cannot occur either.
    expect(
      classify(new Error('IBKR Flex Query error (code 1001): Statement could not be generated'))
    ).toBe(false);
    expect(classify(new Error('IBKR Flex Query error (code 1019): In progress'))).toBe(false);
  });

  it('classifies generic HTTP 401/403 across providers', () => {
    expect(classify(new Error('Bitstamp HTTP 401: Unauthorized'))).toBe(true);
    expect(classify(new Error('Alpaca HTTP 403: forbidden'))).toBe(true);
    expect(classify(new Error('Mercury HTTP 401'))).toBe(true);
  });

  it('classifies Bitfinex "apikey: invalid" in HTTP 5xx bodies', () => {
    const bitfinex500 = 'Bitfinex HTTP 500: ["error",10100,"apikey: invalid"]';
    expect(classify(new Error(bitfinex500))).toBe(true);
  });

  it('classifies bitbank success=0 error codes', () => {
    expect(classify(new Error('bitbank error code 20001'))).toBe(true);
    expect(classify(new Error('bitbank error code 20014'))).toBe(true);
  });

  it('classifies Tiger Brokers gateway errors', () => {
    expect(classify(new Error('Tiger Brokers error 40001: sign invalid'))).toBe(true);
    expect(classify(new Error('Tiger Brokers error 10010: account inactive'))).toBe(true);
  });

  it('classifies Zerodha login / 2FA / session-token flow failures', () => {
    expect(classify(new Error('Zerodha login failed: Invalid user_id or password'))).toBe(true);
    expect(classify(new Error('Zerodha 2FA failed: Invalid TOTP'))).toBe(true);
    expect(classify(new Error('Zerodha session/token failed: token_exchange error'))).toBe(true);
    expect(
      classify(new Error('Zerodha OAuth redirect produced no request_token after 8 hops'))
    ).toBe(true);
    expect(classify(new Error('Zerodha: TokenException — api_key/access_token invalid'))).toBe(
      true
    );
  });

  it('classifies blockchain-misroute errors', () => {
    expect(
      classify(new Error('No wallet manager available or missing userId in credentials'))
    ).toBe(true);
    expect(classify(new Error('Exchange-import targeted a blockchain-type institution'))).toBe(
      true
    );
  });

  it('treats transient errors as retriable', () => {
    expect(classify(new Error('fetch failed: ECONNRESET'))).toBe(false);
    expect(classify(new Error('Bitstamp HTTP 500: Internal Server Error'))).toBe(false);
    expect(classify(new Error('timeout'))).toBe(false);
  });
});

describe('markCredentialFailed', () => {
  it('marks the credential failed and fires captureException', async () => {
    const markImportFailed = mock(async () => {});
    const getCredentials = mock(async () => ({ id: 'cred-1' }));
    Container.set(IntegrationCredentialsService, { getCredentials, markImportFailed });

    const captured: unknown[] = [];
    const captureException = mock((err: unknown) => {
      captured.push(err);
    });

    await __test_markCredentialFailed('u1', 'i1', 'Bitstamp HTTP 401: Unauthorized', {
      captureException,
    });

    expect(getCredentials).toHaveBeenCalledWith('u1', 'i1');
    expect(markImportFailed).toHaveBeenCalledWith('cred-1', 'Bitstamp HTTP 401: Unauthorized');
    expect(captured.length).toBe(1);
    expect((captured[0] as Error).message).toBe(
      'Exchange import terminal failure: Bitstamp HTTP 401: Unauthorized'
    );
  });

  it('skips markImportFailed but still fires captureException when credential is not found', async () => {
    const markImportFailed = mock(async () => {});
    const getCredentials = mock(async () => null);
    Container.set(IntegrationCredentialsService, { getCredentials, markImportFailed });

    const captureException = mock((_err: unknown) => {});

    await __test_markCredentialFailed('u1', 'i1', 'Bitstamp HTTP 401: Unauthorized', {
      captureException,
    });

    expect(markImportFailed).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('swallows bookkeeping errors and still fires captureException', async () => {
    const markImportFailed = mock(async () => {
      throw new Error('DB error');
    });
    const getCredentials = mock(async () => ({ id: 'cred-2' }));
    Container.set(IntegrationCredentialsService, { getCredentials, markImportFailed });

    const captureException = mock((_err: unknown) => {});

    // Must not throw even if markImportFailed throws
    await expect(
      __test_markCredentialFailed('u1', 'i1', 'some failure', { captureException })
    ).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

/**
 * SC-1524, measured on a local stack: IBKR connect skips server validation, so
 * a fake Flex token "connected" in 0.3s and the import job then failed ~2.5
 * minutes later with "tried 3 times and failed every time" and no reason —
 * IBKR's 1015 ("Token is invalid") was retried as though it were transient,
 * and the credential row was left `enqueued` once the retries ran out.
 */
describe('ExchangeImportProcessor — IBKR failures', () => {
  const data: ExchangeImportJob = {
    userId: 'u1',
    requestId: 'r1',
    institutionId: 'i1',
    provider: 'Interactive Brokers',
  };

  function ctxFor(attemptsMade: number, attempts = 3): ProcessorContext {
    return {
      job: { id: 'job-1', attemptsMade, opts: { attempts } },
      reportProgress: async () => undefined,
      reportStatus: async () => undefined,
    } as unknown as ProcessorContext;
  }

  class TestableProcessor extends ExchangeImportProcessor {
    // `handle` is protected; the failure classification is the subject here,
    // not BullMQ's dispatch around it.
    run(job: ExchangeImportJob, ctx: ProcessorContext) {
      return this.handle(job, ctx);
    }
  }

  // The real provider against a fake SendRequest, so the error under test is
  // the one IBKR's reply actually produces rather than a hand-written string.
  async function ibkrFailure(code: string, ibkrMessage: string): Promise<Error> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `<FlexStatementResponse><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${ibkrMessage}</ErrorMessage></FlexStatementResponse>`,
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const limiter = { execute: async <T>(fn: () => Promise<T>) => fn() };
      await new IbkrProvider(limiter as never, async () => {}).fetchBalances({
        institutionCode: 'ibkr',
        credentialsRef: { userId: 'u1', institutionId: 'i1' },
        resolveCredentials: async () => ({ flexQueryToken: 'fake', flexQueryId: '1' }),
      } as never);
      throw new Error('expected the provider to throw');
    } catch (error) {
      return error as Error;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function setup(thrown: Error) {
    const markImportFailed = mock(async (_id: string, _reason: string) => {});
    const getCredentials = mock(async () => ({ id: 'cred-1' }));
    Container.set(IntegrationCredentialsService, { getCredentials, markImportFailed });
    Container.set(BullMqEnqueueService, { add: mock(async () => undefined) });
    // Wrapped the way ImportIbkrAccountsUseCase wraps a per-account failure.
    Container.set(ImportIbkrAccountsUseCase, {
      execute: async () => {
        throw new Error(`IBKR import failed: ${thrown.message}`, { cause: thrown });
      },
    });
    return { markImportFailed, processor: new TestableProcessor() };
  }

  async function failureOf(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the job to fail');
  }

  it.each([
    ['1015', 'Token is invalid.', 'IBKR rejected this Flex token'],
    ['1014', 'Query is invalid.', 'IBKR has no Flex Query with this id'],
  ])(
    'fails %s on the first attempt, names it, and marks the credential failed',
    async (code, ibkrMessage, sentence) => {
      const { markImportFailed, processor } = setup(await ibkrFailure(code, ibkrMessage));

      const error = await failureOf(processor.run(data, ctxFor(0)));

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(userFacingMessage(error)).toStartWith(sentence);
      expect(markImportFailed).toHaveBeenCalledTimes(1);
      expect(markImportFailed.mock.calls[0]?.[1]).toContain(`code ${code}`);
    }
  );

  it('marks the credential failed when retries run out, and names the last reason', async () => {
    // 1019 throughout: IBKR still generating after the provider's whole poll
    // budget — retryable, so the descriptor's 3 attempts are spent first.
    const providerError = await ibkrFailure('1019', 'Statement generation in progress.');
    const { markImportFailed, processor } = setup(providerError);

    const error = await failureOf(processor.run(data, ctxFor(2)));

    // Still an exhaustion, not an UnrecoverableError: the chip must read
    // "tried 3 times", which is what happened.
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(error)).toBe(providerError.message);
    expect(markImportFailed).toHaveBeenCalledTimes(1);
    expect(markImportFailed.mock.calls[0]?.[1]).toContain('code 1019');
  });

  it('leaves the credential alone while a retry is still coming', async () => {
    const { markImportFailed, processor } = setup(
      await ibkrFailure('1019', 'Statement generation in progress.')
    );

    const error = await failureOf(processor.run(data, ctxFor(0)));

    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(error)).toBeNull();
    expect(markImportFailed).not.toHaveBeenCalled();
  });

  it('shows the owner nothing it was not written for when the last attempt fails internally', async () => {
    const { markImportFailed, processor } = setup(
      new Error('select "id" from "holdings" where "user_id" = $1')
    );

    const error = await failureOf(processor.run(data, ctxFor(2)));

    expect(userFacingMessage(error)).toBeNull();
    expect(markImportFailed).toHaveBeenCalledTimes(1);
  });

  // SC-1545. The job is enqueued after its credential row is committed, so a
  // user, credential or institution missing at run time was removed in between
  // and a retry reads the same absence. As plain Errors these were retried,
  // then filed in the dead-letter queue as failures.
  describe('a request naming something that is gone', () => {
    function setupRefusal(thrown: Error) {
      const markImportFailed = mock(async (_id: string, _reason: string) => {});
      const getCredentials = mock(async () => ({ id: 'cred-1' }));
      Container.set(IntegrationCredentialsService, { getCredentials, markImportFailed });
      Container.set(BullMqEnqueueService, { add: mock(async () => undefined) });
      // Thrown bare, the way both use cases raise it: nothing wraps a refusal.
      const useCase = {
        execute: async () => {
          throw thrown;
        },
      };
      Container.set(ImportIbkrAccountsUseCase, useCase);
      Container.set(ImportExchangeAccountsUseCase, useCase);
      return { markImportFailed, processor: new TestableProcessor() };
    }

    const refusals = [
      ['a user', new ImportTargetGoneError('user', 'User not found')],
      [
        'a credential',
        new ImportTargetGoneError('credentials', 'No credentials found for this institution'),
      ],
      ['an institution', new ImportTargetGoneError('institution', 'Institution not found: i1')],
    ] as const;

    describe.each([
      ['IBKR', 'Interactive Brokers'],
      ['exchange', 'Kraken'],
    ])('%s import', (_name, provider) => {
      it.each(refusals)('%s that is gone fails once, with no retry', async (_what, refused) => {
        const { processor } = setupRefusal(refused);

        // First of three attempts: a plain Error here is rethrown and retried.
        const error = await failureOf(processor.run({ ...data, provider }, ctxFor(0)));

        expect(error).toBeInstanceOf(UnrecoverableError);
      });

      it.each(refusals)(
        '%s that is gone shows the owner what it did before',
        async (_what, refused) => {
          const { processor } = setupRefusal(refused);

          const error = await failureOf(processor.run({ ...data, provider }, ctxFor(0)));

          // Same words, and still not marked for the owner: no sentence is added.
          expect(error.message).toBe(refused.message);
          expect(userFacingMessage(error)).toBeNull();
        }
      );

      it('marks the credential failed once, as an exhausted import did', async () => {
        const { markImportFailed, processor } = setupRefusal(refusals[2][1]);

        await failureOf(processor.run({ ...data, provider }, ctxFor(0)));

        expect(markImportFailed).toHaveBeenCalledTimes(1);
        expect(markImportFailed.mock.calls[0]?.[1]).toBe('Institution not found: i1');
      });

      it('CONTROL: a lookup that fails is rethrown as it came, and retried', async () => {
        const lookupFailed = new Error('Failed query: select from "institutions"');
        const { markImportFailed, processor } = setupRefusal(lookupFailed);

        const error = await failureOf(processor.run({ ...data, provider }, ctxFor(0)));

        expect(error).toBe(lookupFailed);
        expect(error).not.toBeInstanceOf(UnrecoverableError);
        expect(markImportFailed).not.toHaveBeenCalled();
      });
    });
  });
});
