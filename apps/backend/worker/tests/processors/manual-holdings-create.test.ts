/**
 * SC-303. `holdings` has no uniqueness on (account_id, token_id), so a payload
 * naming one token twice used to become two rows in one account — four RUB
 * rows arrived from a single Tinkoff payload in production. The use case
 * refuses that payload now; these pin what the refusal looks like by the time
 * it reaches a person.
 *
 * Two things are being asserted, and neither is about the guard itself:
 *
 * - The failure is `UnrecoverableError`. This descriptor is already
 *   RETRY_NONE, so nothing changes about attempts — what changes is
 *   `onTerminalFailure`, which skips UnrecoverableError. Somebody entering
 *   RUB twice must not page Sentry.
 * - The message names symbols. The domain layer only has uuids, and a
 ***REMOVED***
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { CreateHoldingsWithDependenciesUseCase, DuplicateHoldingTokenError } from '@scani/domain';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { ManualHoldingsCreateJob } from '@scani/jobs';
import { type ProcessorContext, UnrecoverableError } from '@scani/queue';
import { Container } from 'typedi';
import {
  describeDuplicateHoldingTokens,
  ManualHoldingsCreateProcessor,
} from '../../src/processors/manual-holdings-create';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const JOB: ManualHoldingsCreateJob = {
  userId: 'user-1',
  requestId: 'req-1',
  baseCurrencyId: 'token-usd',
  accountId: 'acct-1',
  newHoldings: [
    ***REMOVED***
    ***REMOVED***
  ],
  updateHoldings: [],
} as ManualHoldingsCreateJob;

function makeCtx(): ProcessorContext {
  return {
    job: { id: 'job-1' },
    reportProgress: async () => undefined,
    reportStatus: async () => undefined,
  } as unknown as ProcessorContext;
}

/**
 * `handle` is protected, and the three helpers below reach for the database.
 * The error classification between them is the whole subject, so they are
 * stubbed rather than a Postgres stood up.
 */
class TestableProcessor extends ManualHoldingsCreateProcessor {
  run(data: ManualHoldingsCreateJob, ctx: ProcessorContext) {
    return this.handle(data, ctx);
  }

  protected override async loadUser() {
    return { id: 'user-1', baseCurrencyId: 'token-usd' } as Awaited<
      ReturnType<ManualHoldingsCreateProcessor['loadUser']>
    >;
  }

  protected override async resolveBaseCurrencySymbol(): Promise<string> {
    return 'USD';
  }

  protected override async labelTokens(tokenIds: string[]): Promise<string[]> {
    return tokenIds.map((id) => (id === 'token-rub' ? 'RUB' : id));
  }
}

/**
 * `bun test` runs every file in ONE process and typedi's Container is
 * process-global, so the stub below would otherwise reach any later file that
 * resolves this use case — as a failure naming a string from this file
 * (SC-98). Capture the real instance and put it back; `Container.remove` is
 * not the fix, it wipes the `@Service()` registration.
 */
const realUseCase = Container.get(CreateHoldingsWithDependenciesUseCase);
afterEach(() => Container.set(CreateHoldingsWithDependenciesUseCase, realUseCase));

async function failureOf(error: unknown): Promise<unknown> {
  Container.set(CreateHoldingsWithDependenciesUseCase, {
    execute: async () => {
      throw error;
    },
  } as unknown as CreateHoldingsWithDependenciesUseCase);
  try {
    await new TestableProcessor().run(JOB, makeCtx());
  } catch (err) {
    return err;
  }
  throw new Error('expected the processor to throw');
}

describe('ManualHoldingsCreateProcessor error classification', () => {
  test('a duplicate-token refusal fails terminally, naming the symbol', async () => {
    const err = await failureOf(new DuplicateHoldingTokenError(['token-rub'], 'acct-1'));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('RUB');
    // The uuid must not survive into the sentence the user reads.
    expect((err as Error).message).not.toContain('token-rub');
  });

  test('anything else keeps its own class — only the refusal is reclassified', async () => {
    const err = await failureOf(new Error('socket hang up'));
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
  });
});

describe('describeDuplicateHoldingTokens', () => {
  test('one token reads as one thing', () => {
    expect(describeDuplicateHoldingTokens(['RUB'])).toContain('RUB is listed more than once');
  });

  test('several read as several, and the copy says what to do', () => {
    const message = describeDuplicateHoldingTokens(['EUR', 'USD']);
    expect(message).toContain('EUR, USD are listed more than once');
    expect(message).toMatch(/combine the rows or edit the existing holding/);
  });

  // SC-330. The refusal is now one of TWO outcomes, and the other one is the
  // reason this ticket exists: four RUB rows off a Tinkoff screen are four
  // real products. A message that names only the wall sends someone with four
  // pots away to delete three of them.
  test('the copy offers the way out, not only the refusal', () => {
    expect(describeDuplicateHoldingTokens(['RUB'])).toMatch(/separate pots, give each one a name/);
  });
});
