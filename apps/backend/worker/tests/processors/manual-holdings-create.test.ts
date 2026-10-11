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
 *   sentence reading a bare uuid is one nobody can act on.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import {
  CreateHoldingsWithDependenciesUseCase,
  DuplicateHoldingTokenError,
  RecordNotAccessibleError,
} from '@scani/domain';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { ManualHoldingsCreateJob } from '@scani/jobs';
import { type ProcessorContext, UnrecoverableError, userFacingMessage } from '@scani/queue';
import { Container } from 'typedi';
import { describeRefusedRecord } from '../../src/lib/request-refusal';
import {
  describeDuplicateHoldingTokens,
  ManualHoldingsCreateProcessor,
  updateRowBalances,
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
    { tokenId: 'token-rub', balance: '2000.20' },
    { tokenId: 'token-rub', balance: '4000.40' },
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

  protected override async resolveBaseToken(): Promise<Token> {
    return { id: 'token-usd', symbol: 'USD' } as Token;
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

  // SC-1545. Both of these reached the dead-letter queue in production as
  // plain Errors, with the domain layer's own words as the failure reason.
  // This descriptor is RETRY_NONE, so what is pinned is the class (no page, no
  // dead letter) and the sentence (no id, and not the domain message).
  test.each([
    ['an account that is not theirs', 'Access denied to this account'],
    ['an account that is gone', 'Account with ID acct-1 not found'],
  ])('%s fails terminally, in words written for the owner', async (_name, domainMessage) => {
    const err = await failureOf(new RecordNotAccessibleError('account', domainMessage));
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('account'));
    expect((err as Error).message).not.toContain('acct-1');
  });

  test('a balance update naming a holding that is gone fails terminally too', async () => {
    const err = await failureOf(
      new RecordNotAccessibleError('holding', 'Holding holding-1 not found')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('holding'));
    expect((err as Error).message).not.toContain('holding-1');
  });

  // SC-1558. The two refusals SC-1545 left: both were still plain Errors, so
  // still dead-lettered and alerted on.
  test('an institution that is gone fails terminally, in words written for the owner', async () => {
    const err = await failureOf(
      new RecordNotAccessibleError('institution', 'Institution with ID inst-1 not found')
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('institution'));
    expect(userFacingMessage(err)).toContain('institution');
    expect((err as Error).message).not.toContain('inst-1');
  });
});

describe('ManualHoldingsCreateProcessor, the user the job was for', () => {
  /** The real `loadUser` over a stubbed lookup, so the classification is the subject. */
  class OverUserLookup extends ManualHoldingsCreateProcessor {
    constructor(private readonly lookup: () => Promise<unknown>) {
      super();
    }

    run(data: ManualHoldingsCreateJob, ctx: ProcessorContext) {
      return this.handle(data, ctx);
    }

    protected override async findUser() {
      return (await this.lookup()) as Awaited<
        ReturnType<ManualHoldingsCreateProcessor['findUser']>
      >;
    }
  }

  const failureWith = (lookup: () => Promise<unknown>) =>
    new OverUserLookup(lookup).run(JOB, makeCtx()).then(
      () => null,
      (error: unknown) => error
    );

  test('a user that is gone ends the job terminally, with the words it always had', async () => {
    const err = await failureWith(async () => undefined);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe(`User ${JOB.userId} not found`);
    // Nobody is left to read it, so nothing is written for an owner.
    expect(userFacingMessage(err)).toBeNull();
  });

  test('CONTROL: a user lookup that fails is rethrown as it came', async () => {
    const lookupFailed = new Error('Failed query: select from "users"');
    const err = await failureWith(async () => {
      throw lookupFailed;
    });
    expect(err).toBe(lookupFailed);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
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

describe('updateRowBalances (A5 D-20)', () => {
  test('an update reports what was stored, with the typed figure beside it', () => {
    const rows = updateRowBalances(
      [{ holdingId: 'h-1', balance: '150' }],
      new Map([['h-1', '120']])
    );
    expect(rows.get('h-1')).toEqual({ balance: '120', typedBalance: '150' });
  });

  test('CONTROL: a holding stored at the typed figure reads the same twice', () => {
    const rows = updateRowBalances(
      [{ holdingId: 'h-1', balance: '150' }],
      new Map([['h-1', '150']])
    );
    expect(rows.get('h-1')).toEqual({ balance: '150', typedBalance: '150' });
  });
});
