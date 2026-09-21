/**
 * A per-caller allowance on an endpoint that is expensive to serve (SC-1267).
 *
 * The limiter is built on first use rather than at import, because routers are
 * imported before boot hands the shared Redis over; built at import it would
 * silently count in-process, once per machine.
 */

import { createInflowLimiter, getSharedRedis, type InflowRateLimiter } from '@scani/rate-limiter';

export type BudgetVerdict = { ok: true } | { ok: false; retryAfterSec: number };

export class UserBudget {
  private limiter: InflowRateLimiter | null = null;

  constructor(private readonly opts: { namespace: string; max: number; windowMs: number }) {}

  /** Spend `amount` from `key`'s allowance; refused once it would pass `max`. */
  spend(key: string, amount = 1): Promise<BudgetVerdict> {
    this.limiter ??= createInflowLimiter(getSharedRedis(), this.opts);
    return this.limiter.tryConsumeKey(key, amount);
  }
}
