import Decimal from 'decimal.js';
import { z } from 'zod';
import { isValidDecimalString } from '../decimal';

const amount = z
  .string()
  .refine((v) => isValidDecimalString(v) && new Decimal(v).greaterThanOrEqualTo(0), {
    message: 'Must be a non-negative decimal string',
  });

// A zero principal or payment is a loan that never ends.
const positiveAmount = z
  .string()
  .refine((v) => isValidDecimalString(v) && new Decimal(v).greaterThan(0), {
    message: 'Must be a decimal string above zero',
  });

/** `YYYY-MM-DD` that names a real day: `2026-02-31` is not one. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** SC-1640. Every term is optional: an account with no terms still counts in net worth. */
export const SetLiabilityTermsDto = z.object({
  kind: z.enum(['loan', 'credit_card', 'other']),
  annualRatePct: z
    .string()
    .refine((v) => isValidDecimalString(v) && new Decimal(v).gte(0) && new Decimal(v).lte(100), {
      message: 'Rate must be between 0 and 100',
    })
    .optional(),
  termMonths: z.number().int().min(1).max(1200).optional(),
  startDate: z
    .string()
    .refine(isCalendarDate, { message: 'Must be a real date, YYYY-MM-DD' })
    .optional(),
  originalPrincipal: positiveAmount.optional(),
  contractedPayment: positiveAmount.optional(),
  creditLimit: amount.optional(),
  minimumPayment: amount.optional(),
  annualFee: amount.optional(),
});
export type SetLiabilityTermsDto = z.infer<typeof SetLiabilityTermsDto>;

export interface LiabilityScheduleRowDto {
  n: number;
  date: string;
  payment: string;
  interest: string;
  principal: string;
  remaining: string;
}

export interface LiabilityProjectionDto {
  /** From the terms when set, else from the account type (credit_card, else loan or other). */
  kind: 'loan' | 'credit_card' | 'other';
  hasTerms: boolean;
  /** The amount owed, positive. */
  owed: string;
  currency: string | null;
  schedule: LiabilityScheduleRowDto[] | null;
  projection: {
    status: 'paid_off' | 'on_track' | 'ahead' | 'behind';
    payoffDate: string | null;
    remainingInterest: string;
    monthsVsSchedule: number;
    converged: boolean;
  } | null;
  card: { utilization: string | null; available: string | null } | null;
}
