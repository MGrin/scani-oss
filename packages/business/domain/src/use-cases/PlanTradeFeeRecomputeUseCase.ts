import type { DatabaseTransaction } from '@scani/db';
import type { UserJobState } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { UserJobRepository } from '../repositories/UserJobRepository';

/**
 * Which users a one-shot recompute of stored history must reach now that trade
 * fees reach cost basis (SC-1142), and which of them it already has.
 *
 * `portfolio_value_daily` stores cost basis and realized PnL per day, so every
 * user with a fee-bearing transaction holds history computed without fees
 * until they are re-rolled. The nightly rollup reaches back 30 days; the
 * per-user `PORTFOLIO_HISTORY_BACKFILL` reaches 400, and nothing enqueues it
 * for every user.
 *
 * This decides and does not enqueue — enqueueing belongs to a process holding
 * a queue client (`apps/backend/worker/scripts/recompute-trade-fee-history.ts`).
 *
 * Re-running is safe because the caller uses ONE request id for the whole
 * recompute, so each user's job id is fixed and `user_jobs` records what
 * became of it:
 *
 *   - `completed` — done. Skipped.
 *   - `queued` / `active` / `progress` — in flight. Skipped.
 *   - no row, `failed`, `dead` or `cancelled` — enqueued, again if need be.
 */
export interface TradeFeeRecomputePlan {
  completed: string[];
  inFlight: string[];
  toEnqueue: string[];
}

const IN_FLIGHT: ReadonlySet<UserJobState> = new Set(['queued', 'active', 'progress']);

@Service()
export class PlanTradeFeeRecomputeUseCase {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly userJobRepository = Container.get(UserJobRepository);

  async execute(
    input: { jobIdFor: (userId: string) => string; userId?: string },
    transaction?: DatabaseTransaction
  ): Promise<TradeFeeRecomputePlan> {
    const userIds = await this.txRepository.findUserIdsWithTradeFees(
      { userId: input.userId },
      transaction
    );
    const states = await this.userJobRepository.findStatesByJobIds(
      userIds.map(input.jobIdFor),
      transaction
    );
    const plan: TradeFeeRecomputePlan = { completed: [], inFlight: [], toEnqueue: [] };
    for (const userId of userIds) {
      const state = states.get(input.jobIdFor(userId));
      if (state === 'completed') plan.completed.push(userId);
      else if (state !== undefined && IN_FLIGHT.has(state)) plan.inFlight.push(userId);
      else plan.toEnqueue.push(userId);
    }
    return plan;
  }
}
