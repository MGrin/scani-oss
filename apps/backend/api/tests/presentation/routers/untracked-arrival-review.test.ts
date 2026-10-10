/**
 * "Was this the transfer to <account>?" (SC-1696). The service is stubbed, so
 * this proves only the ROUTER's part: every call is scoped to `ctx.userId`,
 * each refusal is a status the sheet can act on rather than a 500, and the
 * input names both rows. What the service does is
 * `UntrackedArrivalReviewService.test.ts`'s job.
 */

import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { UntrackedArrivalReviewService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OUTFLOW_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const INFLOW_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const KEY = { outflowId: OUTFLOW_ID, inflowId: INFLOW_ID };
const SENT_AT = new Date('2026-10-08T16:00:00.000Z');

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

function stub(outcome: unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  Container.set(UntrackedArrivalReviewService, {
    listDue: record('listDue', []),
    confirm: record('confirm', outcome),
    decline: record('decline', outcome),
  } as unknown as UntrackedArrivalReviewService);
  return calls;
}

describe('untrackedArrivalReview router', () => {
  test('list, yes and no reach the service for the signed-in user, naming both rows', async () => {
    const calls = stub({ ok: true, sentAt: SENT_AT });
    const caller = makeAuthedCaller(user).untrackedArrivalReview;
    await caller.listDue();
    expect(await caller.confirm(KEY)).toEqual({ ok: true });
    expect(await caller.decline(KEY)).toEqual({ ok: true });
    expect(calls.map((c) => [c.method, c.args[0], c.args[1]])).toEqual([
      ['listDue', USER_ID, undefined],
      ['confirm', USER_ID, KEY],
      ['decline', USER_ID, KEY],
    ]);
  });

  test('an answer that names no arrival is refused at the boundary', async () => {
    const calls = stub({ ok: true, sentAt: SENT_AT });
    const caller = makeAuthedCaller(user).untrackedArrivalReview;
    await expect(caller.confirm({ outflowId: OUTFLOW_ID } as typeof KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toEqual([]);
  });

  test('a question no longer asked is NOT_FOUND, a pairing the queue refuses is a CONFLICT', async () => {
    stub({ ok: false, reason: 'gone' });
    const caller = makeAuthedCaller(user).untrackedArrivalReview;
    await expect(caller.confirm(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    stub({ ok: false, reason: 'refused' });
    await expect(caller.confirm(KEY)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
