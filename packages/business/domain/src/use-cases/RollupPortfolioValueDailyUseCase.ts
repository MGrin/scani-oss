/**
 * RollupPortfolioValueDailyUseCase
 *
 * Nightly rollup that computes `portfolio_value_daily` rows for every
 * user for every day in a lookback window, in their configured base
 * currency. Reads layer 1+2 (transactions + observations) via
 * PortfolioValuationAtTimeService and writes the derived cache via
 * PortfolioValueDailyRepository.
 *
 * Deliberately rebuildable: dropping the table and re-running this
 * produces the same rows modulo floating-point / timing details. That
 * property drives the design — if the chart ever looks wrong, wipe
 * the rollup for one user and re-run.
 */

import { withAdvisoryLock } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, eq, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { PortfolioValueDailyRepository } from '../repositories/PortfolioValueDailyRepository';
import { PortfolioValuationAtTimeService } from '../services';

const logger = createComponentLogger('use-case:rollup-portfolio-value-daily');

// Per-user lock key. Both call paths (the `portfolio-value-rollup` cron
// and the `portfolio-history-backfill` user job) wrap their per-user
// rollup work in this same key, so concurrent runs for the SAME user
// serialize cleanly — the second one no-ops while the first finishes.
function rollupLockKey(userId: string): string {
  return `portfolio-value-rollup:${userId}`;
}

export interface RollupSummary {
  usersProcessed: number;
  daysComputed: number;
  /** Users skipped because another rollup was in flight for them. */
  usersSkipped: number;
  errors: Array<{ userId: string; error: string }>;
  durationMs: number;
}

@Service()
export class RollupPortfolioValueDailyUseCase {
  // Class-field DI — see note in BalanceAtTimeService.ts. Previously
  // used `= Container.get(Dep)` as constructor-param defaults, but
  // typedi overrode the default with a ContainerInstance because Bun
  // lacks reflect-metadata emit.
  private readonly valuationService = Container.get(PortfolioValuationAtTimeService);
  private readonly dailyRepository = Container.get(PortfolioValueDailyRepository);

  // Compute rollup rows for every active user for every day in
  // `lookbackDays` that isn't already cached. Defaults to 30 days
  // on the assumption that we run this nightly and only the tail
  // few days can actually have changed — anything earlier is
  // already cached.
  async execute(
    opts: {
      lookbackDays?: number;
      // Scope to a single user — when set, the paged users select is
      // replaced with a single-user query. Used by the manual-create
      // follow-up flow that wants to materialize cached daily values for
      // exactly the user who just created a holding.
      userId?: string;
    } = {}
  ): Promise<RollupSummary> {
    const start = Date.now();
    const lookback = opts.lookbackDays ?? 30;
    const summary: RollupSummary = {
      usersProcessed: 0,
      daysComputed: 0,
      usersSkipped: 0,
      errors: [],
      durationMs: 0,
    };

    // Freeze "now" once per run so all users land on the same day
    // boundaries — `Date.now()` drifting across a long run could bucket
    // two users on different days at midnight UTC, producing inconsistent
    // snapshots. Pre-compute the lookback day list here too.
    const runStart = new Date();
    const days: Array<{ at: Date; snapshotDate: string }> = [];
    for (let i = 0; i < lookback; i++) {
      const day = new Date(runStart.getTime() - i * 24 * 60 * 60 * 1000);
      // Today's bucket uses the exact runStart so we get a real "right
      // now" snapshot rather than pretending it's end-of-day UTC in the
      // future. All earlier days snap to 23:59:59.999Z as the "as-of"
      // instant for that day.
      if (i > 0) day.setUTCHours(23, 59, 59, 999);
      const snapshotDate = day.toISOString().slice(0, 10);
      days.push({ at: day, snapshotDate });
    }

    // Iterate users in pages so we don't load the whole users table at
    // once. Filter to users that have a base currency configured — the
    // valuation call throws otherwise and there's nothing to rollup.
    // When `userId` is set, skip pagination entirely and look up that
    // single user.
    const PAGE = 500;
    let offset = 0;
    while (true) {
      const page = opts.userId
        ? await db
            .select({ id: schema.users.id, baseCurrencyId: schema.users.baseCurrencyId })
            .from(schema.users)
            .where(
              and(eq(schema.users.id, opts.userId), sql`${schema.users.baseCurrencyId} IS NOT NULL`)
            )
            .limit(1)
        : await db
            .select({ id: schema.users.id, baseCurrencyId: schema.users.baseCurrencyId })
            .from(schema.users)
            .where(sql`${schema.users.baseCurrencyId} IS NOT NULL`)
            .limit(PAGE)
            .offset(offset);
      if (page.length === 0) break;

      for (const user of page) {
        if (!user.baseCurrencyId) continue; // type-narrow; already filtered
        const baseCurrencyId = user.baseCurrencyId;
        try {
          // Per-user advisory lock: serializes this user's rollup against
          // any concurrent run (the cron sweep + a user-initiated
          // portfolio-history-backfill, two cron containers overlapping
          // on a redeploy, …). Lock-held users are skipped — the holder
          // is producing fresh rows; we'll catch this user the next tick.
          const outcome = await withAdvisoryLock(rollupLockKey(user.id), async () => {
            let daysForUser = 0;
            for (const { at, snapshotDate } of days) {
              const result = await this.valuationService.getPortfolioValue(
                user.id,
                at,
                baseCurrencyId
              );
              await this.dailyRepository.upsert({
                userId: user.id,
                snapshotDate,
                baseCurrencyId,
                totalValue: result.totalValueInBase.toString(),
                coverageQuality: result.coverageQuality,
                holdingsWithKnownValue: result.holdingsWithKnownValue,
                holdingsTotal: result.holdingsTotal,
              });
              daysForUser++;
            }
            return daysForUser;
          });

          if (!outcome.ran) {
            summary.usersSkipped++;
            logger.info(
              { userId: user.id },
              'Rollup skipped for user — another instance holds the lock'
            );
            continue;
          }

          summary.usersProcessed++;
          summary.daysComputed += outcome.result;
        } catch (error) {
          summary.errors.push({
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          logger.warn(
            { userId: user.id, error: error instanceof Error ? error.message : error },
            'Rollup failed for one user; continuing'
          );
        }
      }

      if (opts.userId) break; // single-user mode: one page, done
      offset += PAGE;
      if (page.length < PAGE) break;
    }

    summary.durationMs = Date.now() - start;
    logger.info({ summary }, 'Portfolio value daily rollup complete');
    return summary;
  }
}
