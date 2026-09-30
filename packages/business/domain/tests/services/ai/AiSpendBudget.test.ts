import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import {
  AI_CALLS_GLOBAL_PER_HOUR,
  AI_CALLS_PER_USER_PER_DAY,
  AiBudgetCounter,
  AiBudgetExceededError,
  AiSpendBudget,
} from '../../../src/services/ai/AiSpendBudget';
import {
  PLAN_RESOLVER,
  type PlanAccess,
  registerPlanResolver,
  UNLIMITED_ACCESS,
} from '../../../src/services/plan/plan-resolver';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

/** An in-process counter the test can read back, standing in for Redis. */
class FakeCounter {
  readonly values = new Map<string, number>();
  failing = false;
  async incrBy(key: string, by: number): Promise<number> {
    if (this.failing) throw new Error('redis down');
    const next = (this.values.get(key) ?? 0) + by;
    this.values.set(key, next);
    return next;
  }
  async decrBy(key: string, by: number): Promise<void> {
    this.values.set(key, (this.values.get(key) ?? 0) - by);
  }
}

let counter: FakeCounter;
const budget = () => {
  Container.set(AiBudgetCounter, counter as unknown as AiBudgetCounter);
  return new AiSpendBudget();
};
const NOW = new Date('2026-09-19T11:30:00Z');

beforeEach(() => {
  counter = new FakeCounter();
});

afterEach(() => {
  Container.remove(PLAN_RESOLVER);
});

describe('AiSpendBudget', () => {
  test('a user gets exactly the daily allowance, then a refusal that names the user scope', async () => {
    const b = budget();
    for (let i = 0; i < AI_CALLS_PER_USER_PER_DAY; i++) await b.reserve('u1', 1, NOW);
    const refused = await b.reserve('u1', 1, NOW).catch((e) => e);
    expect(refused).toBeInstanceOf(AiBudgetExceededError);
    expect(refused.scope).toBe('user');
    await b.reserve('u2', 1, NOW);
  });

  test('a batch counts every image, and one that would cross the limit is refused whole', async () => {
    const b = budget();
    await b.reserve('u1', AI_CALLS_PER_USER_PER_DAY - 3, NOW);
    await expect(b.reserve('u1', 10, NOW)).rejects.toBeInstanceOf(AiBudgetExceededError);
    await b.reserve('u1', 3, NOW);
  });

  test('a refusal takes back what it counted, so it does not eat the global budget', async () => {
    const b = budget();
    await b.reserve('u1', AI_CALLS_PER_USER_PER_DAY, NOW);
    await expect(b.reserve('u1', 5, NOW)).rejects.toBeInstanceOf(AiBudgetExceededError);
    const global = [...counter.values].find(([k]) => k.startsWith('ai:budget:global:'));
    expect(global?.[1]).toBe(AI_CALLS_PER_USER_PER_DAY);
  });

  test('the global hourly cap stops everyone once reached, whatever each user has left', async () => {
    const b = budget();
    let user = 0;
    let spent = 0;
    while (spent < AI_CALLS_GLOBAL_PER_HOUR) {
      const n = Math.min(10, AI_CALLS_GLOBAL_PER_HOUR - spent);
      await b.reserve(`u${user++}`, n, NOW);
      spent += n;
    }
    const refused = await b.reserve('fresh-user', 1, NOW).catch((e) => e);
    expect(refused).toBeInstanceOf(AiBudgetExceededError);
    expect(refused.scope).toBe('global');
  });

  test('the next day and the next hour start fresh', async () => {
    const b = budget();
    await b.reserve('u1', AI_CALLS_PER_USER_PER_DAY, NOW);
    await b.reserve('u1', 1, new Date('2026-09-20T00:00:01Z'));
  });

  test('when the counter cannot be reached it refuses rather than spending blind', async () => {
    counter.failing = true;
    await expect(budget().reserve('u1', 1, NOW)).rejects.toBeInstanceOf(AiBudgetExceededError);
  });

  describe('monthly cap from the plan resolver', () => {
    const capped = (aiMonthlyCap: number | null, calls?: { n: number }) =>
      registerPlanResolver({
        forUser: async (): Promise<PlanAccess> => {
          if (calls) calls.n++;
          return { ...UNLIMITED_ACCESS, aiMonthlyCap };
        },
      });
    const day = (n: number) => new Date(Date.UTC(2026, 8, n, 12));

    test('the reservation past the monthly cap is refused with scope month and takes back day and global', async () => {
      capped(30);
      const b = budget();
      for (let d = 1; d <= 3; d++) {
        for (let i = 0; i < 10; i++) await b.reserve('u1', 1, day(d));
      }
      const refused = await b.reserve('u1', 1, day(4)).catch((e) => e);
      expect(refused).toBeInstanceOf(AiBudgetExceededError);
      expect(refused.scope).toBe('month');
      expect(counter.values.get('ai:budget:user:u1:2026-09-04')).toBe(0);
      expect(counter.values.get('ai:budget:global:2026-09-04T12')).toBe(0);
      expect(counter.values.get('ai:budget:user-month:u1:2026-09')).toBe(30);
    });

    test('a new month starts fresh', async () => {
      capped(30);
      const b = budget();
      for (let d = 1; d <= 3; d++) {
        for (let i = 0; i < 10; i++) await b.reserve('u1', 1, day(d));
      }
      await b.reserve('u1', 1, new Date('2026-10-01T00:00:01Z'));
    });

    test('a null cap never touches the monthly key', async () => {
      capped(null);
      await budget().reserve('u1', 1, NOW);
      expect([...counter.values.keys()].some((k) => k.includes('user-month'))).toBe(false);
    });

    test('with no resolver registered there is no monthly key either', async () => {
      await budget().reserve('u1', 1, NOW);
      expect([...counter.values.keys()].some((k) => k.includes('user-month'))).toBe(false);
    });

    test('the resolver is asked once per reserve', async () => {
      const calls = { n: 0 };
      capped(30, calls);
      await budget().reserve('u1', 1, NOW);
      expect(calls.n).toBe(1);
    });

    test('a resolver that throws applies no monthly cap, and the day and global caps still count (R30)', async () => {
      registerPlanResolver({
        forUser: async () => {
          throw new Error('db down');
        },
      });
      const b = budget();
      await b.reserve('u1', 1, NOW);
      expect([...counter.values.keys()].some((k) => k.includes('user-month'))).toBe(false);
      expect(counter.values.get('ai:budget:user:u1:2026-09-19')).toBe(1);
      expect(counter.values.get('ai:budget:global:2026-09-19T11')).toBe(1);

      for (let i = 1; i < AI_CALLS_PER_USER_PER_DAY; i++) await b.reserve('u1', 1, NOW);
      const refused = await b.reserve('u1', 1, NOW).catch((e) => e);
      expect(refused).toBeInstanceOf(AiBudgetExceededError);
      expect(refused.scope).toBe('user');
    });
  });
});
