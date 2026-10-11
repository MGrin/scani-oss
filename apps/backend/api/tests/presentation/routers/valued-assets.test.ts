/**
 * The valuedAssets router (SC-1643): every write rebuilds the rollup from the
 * day it changes, never from today, and another user's asset reads as not
 * found. Committed rows: the router reads through the process-wide handle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService, QueueClient } from '@scani/queue';
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;

const DAY = 86_400_000;
const dayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const enqueued: Array<{ fromDay?: string; userId?: string }> = [];
const users: User[] = [];

async function eurUser(): Promise<User> {
  const [eur] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(and(eq(schema.tokens.symbol, 'EUR'), eq(schema.tokenTypes.code, 'fiat')));
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `vat-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'VA',
      baseCurrencyId: eur!.id,
    })
    .returning();
  users.push(user!);
  return user!;
}

async function enqueuedStart(): Promise<string | undefined> {
  for (let i = 0; i < 200 && enqueued.length === 0; i++) await Bun.sleep(10);
  expect(enqueued).toHaveLength(1);
  return enqueued[0]!.fromDay;
}

const flat = (purchaseDate: string) => ({
  name: `Flat ${randomUUID().slice(0, 4)}`,
  currencyCode: 'EUR',
  purchaseDate,
  purchasePrice: '310000',
  currentValue: '355000',
  details: { kind: 'property' as const, areaSqm: 72 },
});

beforeAll(() => {
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
  const ids = users.map((u) => u.id);
  const accounts = await db
    .select({ institutionId: schema.accounts.institutionId })
    .from(schema.accounts)
    .where(inArray(schema.accounts.userId, ids));
  const tokens = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(inArray(schema.tokens.createdByUserId, ids));
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
  if (tokens.length)
    await db.delete(schema.tokens).where(
      inArray(
        schema.tokens.id,
        tokens.map((t) => t.id)
      )
    );
  const institutionIds = accounts.map((a) => a.institutionId).filter((id): id is string => !!id);
  if (institutionIds.length)
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
});

describe('valuedAssets (SC-1643)', () => {
  test('create rebuilds the rollup from the purchase date', async () => {
    const user = await eurUser();
    await makeAuthedCaller(user).valuedAssets.create({ asset: flat('2021-04-12') });
    expect(await enqueuedStart()).toBe('2021-04-12');
  });

  test('addValuation rebuilds from its day; two for one past day both land and the second wins', async () => {
    const user = await eurUser();
    const caller = makeAuthedCaller(user);
    const { holdingId } = await caller.valuedAssets.create({ asset: flat(dayAgo(400)) });
    expect(await enqueuedStart()).toBe(dayAgo(400));
    enqueued.length = 0;

    await caller.valuedAssets.addValuation({
      valuation: { holdingId, occurredOn: dayAgo(30), value: '340000' },
    });
    expect(await enqueuedStart()).toBe(dayAgo(30));
    enqueued.length = 0;
    await caller.valuedAssets.addValuation({
      valuation: { holdingId, occurredOn: dayAgo(30), value: '345000' },
    });
    expect(await enqueuedStart()).toBe(dayAgo(30));

    const history = await caller.valuedAssets.history({ holdingId });
    const day = history.valuations.filter((v) => v.on === dayAgo(30));
    expect(day.map((v) => [v.value, v.replaced])).toEqual([
      ['340000', true],
      ['345000', false],
    ]);
  });

  test('a valuation today is what the holdings read reports', async () => {
    const user = await eurUser();
    const caller = makeAuthedCaller(user);
    const { holdingId } = await caller.valuedAssets.create({ asset: flat(dayAgo(400)) });
    await caller.valuedAssets.addValuation({
      valuation: { holdingId, occurredOn: dayAgo(0), value: '360000' },
    });
    await caller.valuedAssets.addValuation({
      valuation: { holdingId, occurredOn: dayAgo(0), value: '361000' },
    });

    const read = JSON.stringify(await caller.holdings.getWithDetails());
    expect(read).toContain(holdingId);
    expect(read).toMatch(/361000/);
    expect(read).not.toMatch(/"360000/);
  });

  test("another user's asset is NOT_FOUND", async () => {
    const owner = await eurUser();
    const other = await eurUser();
    const { holdingId } = await makeAuthedCaller(owner).valuedAssets.create({
      asset: flat('2021-04-12'),
    });
    await expect(makeAuthedCaller(other).valuedAssets.history({ holdingId })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      }
    );
    await expect(
      makeAuthedCaller(other).valuedAssets.addValuation({
        valuation: { holdingId, occurredOn: dayAgo(1), value: '1' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a valuation before the purchase is BAD_REQUEST', async () => {
    const user = await eurUser();
    const caller = makeAuthedCaller(user);
    const { holdingId } = await caller.valuedAssets.create({ asset: flat('2021-04-12') });
    await expect(
      caller.valuedAssets.addValuation({
        valuation: { holdingId, occurredOn: '2020-01-01', value: '1' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
