import type { DatabaseTransaction } from '@scani/db';
import type { UserJobState } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../repositories/PortfolioValueDailyRepository';
import { UserJobRepository } from '../repositories/UserJobRepository';

/**
 * Which users a one-shot recompute of stored history must reach, and which of
 * them it already has.
 *
 * `portfolio_value_daily` is a cache the nightly rollup re-walks only 30 days
 * back; the per-user `PORTFOLIO_HISTORY_BACKFILL` reaches 400, and nothing
 * enqueues it for every user. So a change to how a past day is valued leaves
 * every older stored row wrong until someone re-rolls it. Each cohort names
 * one such change:
 *
 *   - `trade-fees` (SC-1142) — fees reach cost basis; every user with a
 *     fee-bearing transaction.
 *   - `stored-history` (SC-1323, SC-1328) — a holding is absent before its
 *     first record and while inactive; every user holding any stored day in
 *     the window, because a projected row can sit on any of them.
 *
 * This decides and does not enqueue — enqueueing belongs to a process holding
 * a queue client (`apps/backend/worker/scripts/recompute-portfolio-history.ts`).
 *
 * Re-running is safe because the caller uses ONE request id for the whole
 * recompute, so each user's job id is fixed and `user_jobs` records what
 * became of it:
 *
 *   - `completed` — done. Skipped.
 *   - `queued` / `active` / `progress` — in flight. Skipped.
 *   - no row, `failed`, `dead` or `cancelled` — enqueued, again if need be.
 */
export type HistoryRecomputeCohort = 'trade-fees' | 'stored-history';

export interface HistoryRecomputePlan {
  completed: string[];
  inFlight: string[];
  toEnqueue: string[];
}

const IN_FLIGHT: ReadonlySet<UserJobState> = new Set(['queued', 'active', 'progress']);

@Service()
export class PlanHistoryRecomputeUseCase {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly dailyRepository = Container.get(PortfolioValueDailyRepository);
  private readonly userJobRepository = Container.get(UserJobRepository);

  async execute(
    input: {
      cohort: HistoryRecomputeCohort;
      jobIdFor: (userId: string) => string;
      /** First day of the window the recompute rewrites (`stored-history`). */
      since: Date;
      userId?: string;
    },
    transaction?: DatabaseTransaction
  ): Promise<HistoryRecomputePlan> {
    const userIds =
      input.cohort === 'trade-fees'
        ? await this.txRepository.findUserIdsWithTradeFees({ userId: input.userId }, transaction)
        : await this.dailyRepository.findUserIdsWithHistorySince(
            input.since,
            { userId: input.userId },
            transaction
          );
    const states = await this.userJobRepository.findStatesByJobIds(
      userIds.map(input.jobIdFor),
      transaction
    );
    const plan: HistoryRecomputePlan = { completed: [], inFlight: [], toEnqueue: [] };
    for (const userId of userIds) {
      const state = states.get(input.jobIdFor(userId));
      if (state === 'completed') plan.completed.push(userId);
      else if (state !== undefined && IN_FLIGHT.has(state)) plan.inFlight.push(userId);
      else plan.toEnqueue.push(userId);
    }
    return plan;
  }
}
