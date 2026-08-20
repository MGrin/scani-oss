import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';

export const PayoutFrequency = z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']);
export type PayoutFrequency = z.infer<typeof PayoutFrequency>;

/**
 * How many payouts a year each frequency makes — the divisor the payout job
 * applies to the annual rate (`ApplyApyPayoutsUseCase`).
 *
 * Here rather than beside the job because the *form* needs it too: a rate is an
 * annual figure and the reader is agreeing to a per-payout one, so the sheet
 * says what the next payout will be worth. Two copies of this table would be
 * two answers to that question, and the wrong one is the one on screen.
 *
 * `weekdays` is 260, not 261 or 262 — a nominal trading year, unchanged from
 * the job's own table, which is what makes it the *same* number rather than a
 * second estimate of it.
 */
export const PAYOUTS_PER_YEAR: Record<PayoutFrequency, number> = {
  daily: 365,
  weekdays: 260,
  weekly: 52,
  monthly: 12,
  yearly: 1,
};

export const UpsertHoldingApyConfigDto = z
  .object({
    holdingId: z.string().uuid(),
    annualRatePct: z.string().refine(
      (val) => {
        if (!isValidDecimalString(val)) return false;
        const d = new Decimal(val);
        return d.greaterThan(0) && d.lessThanOrEqualTo(100);
      },
      { message: 'Annual rate must be a valid decimal between 0 (exclusive) and 100 (inclusive)' }
    ),
    payoutFrequency: PayoutFrequency,
    payoutDayOfWeek: z.number().int().min(0).max(6).nullish(),
    payoutDayOfMonth: z.number().int().min(1).max(31).nullish(),
    payoutMonth: z.number().int().min(1).max(12).nullish(),
  })
  .superRefine((data, ctx) => {
    if (data.payoutFrequency === 'weekly' && data.payoutDayOfWeek == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Day of week is required for weekly payout frequency',
        path: ['payoutDayOfWeek'],
      });
    }
    if (
      (data.payoutFrequency === 'monthly' || data.payoutFrequency === 'yearly') &&
      data.payoutDayOfMonth == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Day of month is required for monthly/yearly payout frequency',
        path: ['payoutDayOfMonth'],
      });
    }
    if (data.payoutFrequency === 'yearly' && data.payoutMonth == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Month is required for yearly payout frequency',
        path: ['payoutMonth'],
      });
    }
  });

export type UpsertHoldingApyConfigInput = z.infer<typeof UpsertHoldingApyConfigDto>;

export type HoldingApyConfigResponse = {
  id: string;
  holdingId: string;
  annualRatePct: string;
  payoutFrequency: string;
  payoutDayOfWeek: number | null;
  payoutDayOfMonth: number | null;
  payoutMonth: number | null;
  lastPayoutAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
