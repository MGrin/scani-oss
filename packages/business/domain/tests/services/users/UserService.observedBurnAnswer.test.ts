import { describe, expect, test } from 'bun:test';
import type { User } from '@scani/db/schema';
import type { ObservedBurnAnswerInput } from '@scani/shared';
import { Container } from 'typedi';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { UserService } from '../../../src/services/users/UserService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

/**
 * SC-661. Overriding the measured drain, confirming it, and withdrawing either.
 *
 * ## What is actually being pinned here
 *
 * Not that a write happens — that the write is TOTAL. The three intentions are
 * mutually exclusive and the database enforces it
 * (`users_observed_burn_one_answer`), so a patch that set one pair without
 * clearing the other would be a constraint violation at best and, if the
 * constraint were ever relaxed, a row with two authoritative answers to one
 * question: this ticket's own defect moved from two screens into one row.
 *
 * The assertions therefore check all SIX columns on every call, including the
 * ones the intention does not concern. Asserting only the columns each branch
 * sets is what would let a half-patch through.
 */

const TOKEN = '11111111-2222-3333-4444-555555555555';

function makeService(): { service: UserService; patches: Partial<User>[] } {
  const patches: Partial<User>[] = [];
  const stub = {
    findById: async () => ({ id: 'user-1' }) as User,
    update: async (_id: string, data: Partial<User>) => {
      patches.push(data);
      return { id: 'user-1', ...data } as User;
    },
  };
  Container.set(UserRepository, stub as unknown as UserRepository);
  const service = new UserService();
  Container.set(UserService, service);
  return { service, patches };
}

async function patchFor(input: ObservedBurnAnswerInput): Promise<Partial<User>> {
  const { service, patches } = makeService();
  await service.setObservedBurnAnswer('user-1', input);
  expect(patches).toHaveLength(1);
  return patches[0] as Partial<User>;
}

describe('SC-661 — UserService.setObservedBurnAnswer', () => {
  test('an override writes its three columns and clears the confirmation', async () => {
    const patch = await patchFor({ kind: 'override', amount: '6300', currencyTokenId: TOKEN });

    expect(patch.observedBurnOverride).toBe('6300');
    expect(patch.observedBurnOverrideCurrencyId).toBe(TOKEN);
    expect(patch.observedBurnOverrideAt).toBeInstanceOf(Date);
    // The half the intention does not concern, and the half a partial patch
    // would have left standing.
    expect(patch.observedBurnConfirmedValue).toBeNull();
    expect(patch.observedBurnConfirmedCurrencyId).toBeNull();
    expect(patch.observedBurnConfirmedAt).toBeNull();
  });

  /**
   * The value is stored because it is **what must still match** for the
   * confirmation to mean anything. The drain is recomputed whenever the window
   * moves; a confirmation kept as a bare timestamp goes on reading as agreement
   * after the figure it agreed with has changed. Same defect as SC-673's
   * `answerSourceOf` inferring who answered from a timestamp.
   */
  test('a confirmation stores the figure it agreed with, and clears the override', async () => {
    const patch = await patchFor({ kind: 'confirm', value: '8100', currencyTokenId: TOKEN });

    expect(patch.observedBurnConfirmedValue).toBe('8100');
    expect(patch.observedBurnConfirmedCurrencyId).toBe(TOKEN);
    expect(patch.observedBurnConfirmedAt).toBeInstanceOf(Date);
    expect(patch.observedBurnOverride).toBeNull();
    expect(patch.observedBurnOverrideCurrencyId).toBeNull();
    expect(patch.observedBurnOverrideAt).toBeNull();
  });

  test('clearing withdraws both, whichever was standing', async () => {
    const patch = await patchFor({ kind: 'clear' });

    for (const value of Object.values(patch)) expect(value).toBeNull();
    expect(Object.keys(patch).sort()).toEqual([
      'observedBurnConfirmedAt',
      'observedBurnConfirmedCurrencyId',
      'observedBurnConfirmedValue',
      'observedBurnOverride',
      'observedBurnOverrideAt',
      'observedBurnOverrideCurrencyId',
    ]);
  });

  /**
   * Every branch writes the same six keys. This is the assertion that fails if
   * somebody later "optimises" a branch down to the columns it cares about —
   * which reads as tidier and is exactly how the stale half gets left behind.
   */
  test('every intention writes all six columns, not just its own', async () => {
    const inputs: ObservedBurnAnswerInput[] = [
      { kind: 'override', amount: '6300', currencyTokenId: TOKEN },
      { kind: 'confirm', value: '8100', currencyTokenId: TOKEN },
      { kind: 'clear' },
    ];

    for (const input of inputs) {
      const patch = await patchFor(input);
      expect(Object.keys(patch)).toHaveLength(6);
    }
  });

  /**
   * The timestamp records when the user last stood behind the answer, not when
   * the answer last differed. Re-affirming the same figure is new information
   * about the older one.
   */
  test('re-stating the same answer re-stamps it', async () => {
    const { service, patches } = makeService();
    const input: ObservedBurnAnswerInput = {
      kind: 'override',
      amount: '6300',
      currencyTokenId: TOKEN,
    };

    await service.setObservedBurnAnswer('user-1', input);
    await service.setObservedBurnAnswer('user-1', input);

    expect(patches).toHaveLength(2);
    expect(patches[0]?.observedBurnOverrideAt).toBeInstanceOf(Date);
    expect(patches[1]?.observedBurnOverrideAt).toBeInstanceOf(Date);
  });
});
