/**
 * SC-1607: a balance edit rebuilds from the holding's observation before the
 * edit, because a day's balance interpolates between the observations either
 * side of it. The edit writes an observation of its own, dated now, so a start
 * read only after the write finds that one and rebuilds today alone. The
 * Neon falsifier caught it: a growth edit started today, and a full rebuild
 * changed every day back to the previous observation.
 *
 * The rows are committed: the router reads through the process-wide handle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { PortfolioValueCache } from '@scani/domain/services';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { BullMqEnqueueService, QueueClient } from '@scani/queue';
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;

const DAY = 86_400_000;
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

let user: User;
let tokenId: string;
const institutionIds: string[] = [];
const enqueued: Array<{ fromDay?: string }> = [];

async function observedHolding(observedDaysAgo: number) {
  const type = await makeInstitutionType(db, { code: 'bank' });
  const institution = await makeInstitution(db, { typeId: type.id });
  institutionIds.push(institution.id);
  const account = await makeAccount(db, { userId: user.id, institutionId: institution.id });
  const holding = await makeHolding(db, {
    userId: user.id,
    accountId: account.id,
    tokenId,
    balance: '100',
  });
  const observedAt = new Date(Date.now() - observedDaysAgo * DAY);
  await db.insert(schema.holdingBalanceObservations).values({
    userId: user.id,
    holdingId: holding.id,
    balance: '100',
    observedAt,
    source: 'statement-close',
    role: 'checkpoint',
    authority: 'statement',
  });
  return { holding, observedDay: utcDay(observedAt) };
}

async function enqueuedStart(): Promise<string | undefined> {
  for (let i = 0; i < 200 && enqueued.length === 0; i++) await Bun.sleep(10);
  expect(enqueued).toHaveLength(1);
  return enqueued[0]!.fromDay;
}

beforeAll(async () => {
  user = await makeUser(db);
  tokenId = (await makeToken(db)).id;
  Container.set(BullMqEnqueueService, {
    add: async (_job: unknown, payload: { fromDay?: string }) => {
      enqueued.push(payload);
      return 'job-1';
    },
  } as unknown as BullMqEnqueueService);
  Container.set(QueueClient, {
    get: () => ({ getJobState: async () => 'unknown', getJob: async () => undefined }),
  } as unknown as QueueClient);
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: () => {},
  } as unknown as RedisRealtimeUpdatesService);
});

beforeEach(() => {
  enqueued.length = 0;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, tokenId));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
});

describe('holdings.update rebuilds from the observation before the edit (SC-1607)', () => {
  test('a growth edit dated now starts at the previous observation, not today', async () => {
    const { holding, observedDay } = await observedHolding(60);

    await makeAuthedCaller(user).holdings.update({
      id: holding.id,
      data: { balance: '130', editCause: 'growth' },
    });

    expect(await enqueuedStart()).toBe(observedDay);
  });

  test('a flow edit with no date starts at the previous observation, not today', async () => {
    const { holding, observedDay } = await observedHolding(45);

    await makeAuthedCaller(user).holdings.update({
      id: holding.id,
      data: { balance: '80', editCause: 'flow' },
    });

    expect(await enqueuedStart()).toBe(observedDay);
  });

  test('control: a flow edit dated before the observation starts at that date', async () => {
    const { holding } = await observedHolding(30);
    const editedAt = new Date(Date.now() - 90 * DAY);

    await makeAuthedCaller(user).holdings.update({
      id: holding.id,
      data: { balance: '80', editCause: 'flow', editOccurredAt: editedAt.toISOString() },
    });

    // No observation at or before the edit: the projection from the first
    // record moves, and the first record is the holding's own creation.
    const start = await enqueuedStart();
    expect(start).toBeDefined();
    expect(start! <= utcDay(editedAt)).toBe(true);
  });
});

describe('edits the Neon falsifier has not proven rebuild in full (SC-1607, #23009)', () => {
  test('restoring a hidden holding queues a full rebuild, with no start day', async () => {
    const { holding } = await observedHolding(20);
    await db
      .update(schema.holdings)
      .set({ isHidden: true, hiddenBy: 'user' })
      .where(eq(schema.holdings.id, holding.id));

    await makeAuthedCaller(user).holdings.restore({ id: holding.id });

    expect(await enqueuedStart()).toBeUndefined();
  });
});
