import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../utils/financial';

export const PayoutFrequency = z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']);
export type PayoutFrequency = z.infer<typeof PayoutFrequency>;

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
