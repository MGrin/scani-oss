import type { DatabaseTransaction } from '@scani/db';
import type { UserJobState } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../repositories/PortfolioValueDailyRepository';
import { UserJobRepository } from '../repositories/UserJobRepository';

/**
 * Which users a one-shot recompute of stored history must reach, and which of
 * them it already has.
 *
 * `portfolio_value_daily` is a cache the nightly rollup re-walks only 30 days
 * back. The per-user `PORTFOLIO_HISTORY_BACKFILL` has no default window: it
 * walks exactly the `lookbackDays` its payload carries, a required field its
 * schema bounds to 1..36,500, which the worker checks when it picks the job
 * up and the enqueue does not. The one floor is on the retry a job schedules
 * when it finds another backfill for the user running, which asks for at
 * least `PORTFOLIO_HISTORY_LOOKBACK_DAYS`. Nothing enqueues the job for every
 * user. So a change to how a past day is valued leaves every older stored row
 * wrong until someone re-rolls it. Each cohort names one such change:
 *
 *   - `trade-fees` (SC-1142) — fees reach cost basis; every user with a
 *     fee-bearing transaction.
 *   - `stored-history` (SC-1323, SC-1328) — a holding is absent before its
 *     first record and while inactive; every user holding any stored day in
 *     the window, because a projected row can sit on any of them.
 *   - `sweep-hidden` (SC-1546) — a holding the closed-position sweep hid is
 *     costed from its ledger and keeps rows of its own; every user with an
 *     active holding the sweep hid, whether or not it has been shown again
 *     since, on a token that is not a scam for them.
 *
 * This decides who and does not enqueue — enqueueing, and how far back each
 * job reaches, belong to a process holding a queue client
 * (`apps/backend/worker/scripts/recompute-portfolio-history.ts`), which sets
 * the window per cohort.
 *
 * Re-running is safe because the caller uses ONE request id for the whole
 * recompute, so each user's job id is fixed and `user_jobs` records what
 * became of it:
 *
 *   - `completed` — done. Skipped.
 *   - `queued` / `active` / `progress` — in flight. Skipped.
 *   - no row, `failed`, `dead` or `cancelled` — enqueued, again if need be.
 */
export type HistoryRecomputeCohort = 'trade-fees' | 'stored-history' | 'sweep-hidden';

export interface HistoryRecomputePlan {
  completed: string[];
  inFlight: string[];
  toEnqueue: string[];
}

const IN_FLIGHT: ReadonlySet<UserJobState> = new Set(['queued', 'active', 'progress']);

@Service()
export class PlanHistoryRecomputeUseCase {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
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
    const userIds = await this.userIdsOf(input, transaction);
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

  private userIdsOf(
    input: { cohort: HistoryRecomputeCohort; since: Date; userId?: string },
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    const opts = { userId: input.userId };
    switch (input.cohort) {
      case 'trade-fees':
        return this.txRepository.findUserIdsWithTradeFees(opts, transaction);
      case 'stored-history':
        return this.dailyRepository.findUserIdsWithHistorySince(input.since, opts, transaction);
      case 'sweep-hidden':
        return this.holdingRepository.findUserIdsWithSweepHiddenHoldings(opts, transaction);
    }
  }
}
