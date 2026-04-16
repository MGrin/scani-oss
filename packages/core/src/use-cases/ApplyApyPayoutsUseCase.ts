import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { withTransaction } from '../database/transaction';
import {
  type ActiveApyConfigWithHolding,
  HoldingApyConfigRepository,
} from '../repositories/HoldingApyConfigRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingService } from '../services/HoldingService';
import { VaultService } from '../services/VaultService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:apply-apy-payouts');

const PAYOUTS_PER_YEAR: Record<string, number> = {
  daily: 365,
  weekdays: 260,
  weekly: 52,
  monthly: 12,
  yearly: 1,
};

/** Maximum catch-up window to prevent runaway compounding */
const MAX_CATCHUP_DAYS = 366;

export interface ApplyApyPayoutsResult {
  holdingsProcessed: number;
  payoutsApplied: number;
  totalInterestApplied: string;
  errors: Array<{ holdingId: string; error: string }>;
  skipped: number;
  durationMs: number;
}

/**
 * Compute the number of days in a given month (1-indexed).
 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Compute all payout dates between startDate (exclusive) and endDate (inclusive)
 * based on the configured frequency and schedule.
 */
export function computeDuePayoutDates(
  startDate: Date,
  endDate: Date,
  frequency: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
  payoutMonth?: number | null
): Date[] {
  const dates: Date[] = [];

  // Start from day after startDate
  const cursor = new Date(startDate);
  cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCDate(cursor.getUTCDate() + 1);

  const end = new Date(endDate);
  end.setUTCHours(23, 59, 59, 999);

  // Safety: cap iteration
  const maxIterations = MAX_CATCHUP_DAYS;
  let iterations = 0;

  while (cursor <= end && iterations < maxIterations) {
    iterations++;
    const dow = cursor.getUTCDay(); // 0=Sun..6=Sat
    const dom = cursor.getUTCDate();
    const month = cursor.getUTCMonth() + 1; // 1-indexed

    let matches = false;

    switch (frequency) {
      case 'daily':
        matches = true;
        break;
      case 'weekdays':
        matches = dow >= 1 && dow <= 5;
        break;
      case 'weekly':
        matches = dow === dayOfWeek;
        break;
      case 'monthly': {
        const maxDay = daysInMonth(cursor.getUTCFullYear(), month);
        const effectiveDay = Math.min(dayOfMonth!, maxDay);
        matches = dom === effectiveDay;
        break;
      }
      case 'yearly': {
        const maxDayY = daysInMonth(cursor.getUTCFullYear(), payoutMonth!);
        const effectiveDayY = Math.min(dayOfMonth!, maxDayY);
        matches = month === payoutMonth && dom === effectiveDayY;
        break;
      }
    }

    if (matches) {
      dates.push(new Date(cursor));
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

@Service()
export class ApplyApyPayoutsUseCase {
  private readonly apyConfigRepository = Container.get(HoldingApyConfigRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly vaultService = Container.get(VaultService);

  async execute(): Promise<ApplyApyPayoutsResult> {
    const startTime = Date.now();
    const now = new Date();
    const errors: Array<{ holdingId: string; error: string }> = [];
    let payoutsApplied = 0;
    let skipped = 0;
    let totalInterest = new Decimal(0);

    logger.info('Starting APY payouts processing');

    // Fetch all active configs with holding data
    const configs = await this.apyConfigRepository.findAllActive();
    logger.info({ count: configs.length }, 'Found active APY configs');

    for (const entry of configs) {
      try {
        const result = await this.processConfig(entry, now);
        if (result.applied) {
          payoutsApplied += result.payoutCount;
          totalInterest = totalInterest.plus(result.interestApplied);
        } else {
          skipped++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { holdingId: entry.holdingId, error: message },
          'Failed to process APY payout'
        );
        errors.push({ holdingId: entry.holdingId, error: message });
      }
    }

    const durationMs = Date.now() - startTime;
    const result: ApplyApyPayoutsResult = {
      holdingsProcessed: configs.length,
      payoutsApplied,
      totalInterestApplied: totalInterest.toFixed(),
      errors,
      skipped,
      durationMs,
    };

    logger.info(result, 'APY payouts processing completed');
    return result;
  }

  private async processConfig(
    entry: ActiveApyConfigWithHolding,
    now: Date
  ): Promise<{ applied: boolean; payoutCount: number; interestApplied: Decimal }> {
    const { config } = entry;
    const frequency = config.payoutFrequency;
    const perYear = PAYOUTS_PER_YEAR[frequency];

    if (!perYear) {
      throw new Error(`Unknown payout frequency: ${frequency}`);
    }

    // Determine start date for catch-up
    const startDate = config.lastPayoutAt || config.createdAt;

    // Compute due payout dates
    const dueDates = computeDuePayoutDates(
      startDate,
      now,
      frequency,
      config.payoutDayOfWeek,
      config.payoutDayOfMonth,
      config.payoutMonth
    );

    if (dueDates.length === 0) {
      return { applied: false, payoutCount: 0, interestApplied: new Decimal(0) };
    }

    const rate = new Decimal(config.annualRatePct).div(100);

    // Re-read balance and compute interest inside a transaction to avoid
    // overwriting concurrent balance changes (exchange sync, manual edit).
    const result = await withTransaction(
      async (tx) => {
        const holding = await this.holdingRepository.findById(entry.holdingId, tx);
        if (!holding) {
          throw new Error(`Holding not found: ${entry.holdingId}`);
        }

        let currentBalance = new Decimal(holding.balance);
        let totalInterest = new Decimal(0);

        for (let i = 0; i < dueDates.length; i++) {
          const interest = currentBalance.mul(rate).div(perYear);
          totalInterest = totalInterest.plus(interest);
          currentBalance = currentBalance.plus(interest);
        }

        const newBalance = currentBalance.toDecimalPlaces(8).toFixed();

        logger.debug(
          {
            holdingId: entry.holdingId,
            payoutCount: dueDates.length,
            oldBalance: holding.balance,
            newBalance,
            interest: totalInterest.toFixed(),
          },
          'Applying APY payout'
        );

        await this.holdingService.updateHoldingBalance(entry.holdingId, newBalance, tx);
        await this.apyConfigRepository.updateLastPayoutAt(config.id, now, tx);

        return { totalInterest };
      },
      { name: `apy-payout-${entry.holdingId}`, timeout: 10000 }
    );

    // Recalculate vaults outside transaction (non-critical)
    try {
      await this.vaultService.recalculateVaultsForHolding(entry.holdingId);
    } catch (error) {
      logger.warn(
        { holdingId: entry.holdingId, error: error instanceof Error ? error.message : error },
        'Failed to recalculate vaults after APY payout'
      );
    }

    return {
      applied: true,
      payoutCount: dueDates.length,
      interestApplied: result.totalInterest,
    };
  }
}
