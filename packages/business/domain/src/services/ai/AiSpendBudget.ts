import { getSharedRedis } from '@scani/rate-limiter';
import { Container, Service } from 'typedi';

/**
 * Caps on AI spending (SC-1265). mgrin, 2026-09-19: an attack must not be able
 * to run up the AI bill. Before this, any signed-in account could parse ten
 * screenshots a call, as many calls as it liked, and the fake accounts from
 * SC-1262 did.
 *
 * One call to an AI model is one unit; a batch of ten images is ten.
 */
export const AI_CALLS_PER_USER_PER_DAY = 20;
export const AI_CALLS_GLOBAL_PER_HOUR = 200;

export type AiBudgetScope = 'user' | 'global' | 'unavailable';

export class AiBudgetExceededError extends Error {
  constructor(readonly scope: AiBudgetScope) {
    super(
      scope === 'user'
        ? `You have reached today's limit of ${AI_CALLS_PER_USER_PER_DAY} AI reads. It resets at midnight UTC.`
        : 'AI reading is paused for a while. Please try again later.'
    );
    this.name = 'AiBudgetExceededError';
  }
}

/**
 * The counter behind the budget. Redis in every deployed process, because the
 * api and the worker spend from the same budget and an in-process count would
 * multiply the cap by the number of machines. The in-memory map serves only a
 * process with no shared Redis at all — a test or a bare local run.
 */
@Service()
export class AiBudgetCounter {
  private readonly local = new Map<string, number>();

  async incrBy(key: string, by: number, ttlSeconds: number): Promise<number> {
    const redis = getSharedRedis();
    if (!redis) {
      const next = (this.local.get(key) ?? 0) + by;
      this.local.set(key, next);
      return next;
    }
    const [[, value]] = (await redis.multi().incrby(key, by).expire(key, ttlSeconds).exec()) as [
      [Error | null, number],
    ];
    return value;
  }

  async decrBy(key: string, by: number): Promise<void> {
    const redis = getSharedRedis();
    if (!redis) {
      this.local.set(key, (this.local.get(key) ?? 0) - by);
      return;
    }
    await redis.decrby(key, by);
  }
}

@Service()
export class AiSpendBudget {
  private readonly counter = Container.get(AiBudgetCounter);

  /**
   * Counts `calls` against the user's day and everyone's hour, or refuses and
   * counts nothing. Call it BEFORE the model is called: the spend it guards is
   * the call itself, whatever the call returns.
   *
   * A counter that cannot be reached refuses too. Failing open would make
   * "Redis is down" the way around the cap.
   */
  async reserve(userId: string, calls: number, now: Date = new Date()): Promise<void> {
    const iso = now.toISOString();
    const userKey = `ai:budget:user:${userId}:${iso.slice(0, 10)}`;
    const globalKey = `ai:budget:global:${iso.slice(0, 13)}`;
    const taken: string[] = [];
    try {
      const perUser = await this.counter.incrBy(userKey, calls, 2 * 86_400);
      taken.push(userKey);
      if (perUser > AI_CALLS_PER_USER_PER_DAY) throw new AiBudgetExceededError('user');

      const global = await this.counter.incrBy(globalKey, calls, 2 * 3_600);
      taken.push(globalKey);
      if (global > AI_CALLS_GLOBAL_PER_HOUR) throw new AiBudgetExceededError('global');
    } catch (error) {
      await Promise.all(taken.map((key) => this.counter.decrBy(key, calls).catch(() => {})));
      throw error instanceof AiBudgetExceededError
        ? error
        : new AiBudgetExceededError('unavailable');
    }
  }
}
