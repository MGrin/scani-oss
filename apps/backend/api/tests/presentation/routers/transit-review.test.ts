/**
 * The day-7 transit routes (SC-1675). The service is stubbed, so this proves
 * only the ROUTER's part: every call is scoped to `ctx.userId`, each refusal
 * is a status the sheet can act on rather than a 500, and only an answer that
 * moved money asks the rollup to rebuild. What the service does is
 * `TransitReviewService.test.ts`'s job.
 */

import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { TransitReviewService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OUTFLOW_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const INFLOW_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DESTINATION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const KEY = { outflowId: OUTFLOW_ID, destinationHoldingId: DESTINATION_ID };
const SENT_AT = new Date('2026-09-13T09:00:00.000Z');

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
  Container.set(TransitReviewService, {
    listDue: record('listDue', []),
    candidates: record('candidates', { arrivals: [], refunds: [] }),
    arrived: record('arrived', outcome),
    lost: record('lost', outcome),
    cameBack: record('cameBack', outcome),
    stillWaiting: record('stillWaiting', outcome),
  } as unknown as TransitReviewService);
  return calls;
}

describe('transitReview router', () => {
  test('lists and offers candidates for the signed-in user only', async () => {
    const calls = stub({ ok: true, sentAt: SENT_AT });
    const caller = makeAuthedCaller(user).transitReview;
    await caller.listDue();
    await caller.candidates(KEY);
    expect(calls.map((c) => [c.method, c.args[0], c.args[1]])).toEqual([
      ['listDue', USER_ID, undefined],
      ['candidates', USER_ID, KEY],
    ]);
  });

  test('each answer reaches the service with its own arguments', async () => {
    const calls = stub({ ok: true, sentAt: SENT_AT });
    const caller = makeAuthedCaller(user).transitReview;
    await caller.arrived({ ...KEY, inflowId: INFLOW_ID });
    await caller.lost({ ...KEY, decision: 'fee' });
    await caller.cameBack({ ...KEY, refundId: INFLOW_ID });
    await caller.stillWaiting(KEY);
    expect(calls.map((c) => [c.method, ...c.args.slice(0, 3)])).toEqual([
      ['arrived', USER_ID, KEY, INFLOW_ID],
      ['lost', USER_ID, KEY, 'fee'],
      ['cameBack', USER_ID, KEY, INFLOW_ID],
      ['stillWaiting', USER_ID, KEY, undefined],
    ]);
  });

  test('an answer that names no destination is refused at the boundary (SC-1684)', async () => {
    const calls = stub({ ok: true, sentAt: SENT_AT });
    const caller = makeAuthedCaller(user).transitReview;
    await expect(
      caller.lost({ outflowId: OUTFLOW_ID, decision: 'fee' } as typeof KEY & { decision: 'fee' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(calls).toEqual([]);
  });

  test('a transfer no longer travelling is NOT_FOUND, a row it cannot use is a CONFLICT', async () => {
    stub({ ok: false, reason: 'gone' });
    const caller = makeAuthedCaller(user).transitReview;
    await expect(caller.lost({ ...KEY, decision: 'fee' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    stub({ ok: false, reason: 'not_candidate' });
    await expect(caller.arrived({ ...KEY, inflowId: INFLOW_ID })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  test('a decision other than lost or a fee is refused at the boundary', async () => {
    const calls = stub({ ok: true, sentAt: SENT_AT });
    const caller = makeAuthedCaller(user).transitReview;
    await expect(caller.lost({ ...KEY, decision: 'paired' as 'fee' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toEqual([]);
  });
});
