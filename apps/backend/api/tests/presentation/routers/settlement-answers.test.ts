/**
 * The settlement-answer routes (SC-1453). The service is stubbed, so this
 * proves only the ROUTER's part: every call is scoped to `ctx.userId`, the
 * second confirmation reaches the service only when the client sent it, and
 * each refusal is a status the screen can act on rather than a 500. What the
 * service does is `SettlementAnswerReviewService.test.ts`'s job.
 */

import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { SettlementAnswerReviewService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OBSERVATION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RETIRED_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const user = {
  id: USER_ID,
  email: 'owner@scani.local',
  name: 'Owner',
  baseCurrencyId: null,
  image: null,
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as typeof schema.users.$inferSelect;

function stub(outcomes: { retire?: unknown; keep?: unknown; undoRetire?: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  Container.set(SettlementAnswerReviewService, {
    listPending: record('listPending', []),
    retire: record('retire', outcomes.retire),
    keep: record('keep', outcomes.keep),
    undoRetire: record('undoRetire', outcomes.undoRetire),
  } as unknown as SettlementAnswerReviewService);
  return calls;
}

describe('settlementAnswers router', () => {
  test('lists for the signed-in user only', async () => {
    const calls = stub({});
    await makeAuthedCaller(user).settlementAnswers.listPending();
    expect(calls).toEqual([{ method: 'listPending', args: [USER_ID] }]);
  });

  test('an answer that moved another holding asks again, and the confirmation is passed on', async () => {
    const calls = stub({ retire: { refusal: 'moves-another-holding' } });
    const caller = makeAuthedCaller(user).settlementAnswers;
    await expect(caller.retire({ observationId: OBSERVATION_ID })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      caller.retire({ observationId: OBSERVATION_ID, confirmOtherHolding: true })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls.map((call) => call.args)).toEqual([
      [USER_ID, OBSERVATION_ID, { confirmOtherHolding: undefined }],
      [USER_ID, OBSERVATION_ID, { confirmOtherHolding: true }],
    ]);
  });

  test('each retire refusal is a status, not a 500', async () => {
    const caller = makeAuthedCaller(user).settlementAnswers;
    for (const [refusal, code] of [
      ['not-redundant', 'CONFLICT'],
      ['linked-elsewhere', 'CONFLICT'],
      ['gone', 'NOT_FOUND'],
    ] as const) {
      stub({ retire: { refusal } });
      await expect(caller.retire({ observationId: OBSERVATION_ID })).rejects.toMatchObject({
        code,
      });
    }
  });

  test('keep on an answer that is gone is NOT_FOUND', async () => {
    const calls = stub({ keep: false });
    await expect(
      makeAuthedCaller(user).settlementAnswers.keep({ observationId: OBSERVATION_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toEqual([{ method: 'keep', args: [USER_ID, OBSERVATION_ID] }]);
  });

  test('each undo refusal is a status, not a 500', async () => {
    const caller = makeAuthedCaller(user).settlementAnswers;
    for (const [refusal, code] of [
      ['answered-since', 'CONFLICT'],
      ['holding-gone', 'CONFLICT'],
      ['already-restored', 'CONFLICT'],
      ['gone', 'NOT_FOUND'],
    ] as const) {
      const calls = stub({ undoRetire: { refusal } });
      await expect(caller.undoRetire({ retiredId: RETIRED_ID })).rejects.toMatchObject({ code });
      expect(calls[0]?.args).toEqual([USER_ID, RETIRED_ID]);
    }
  });
});
