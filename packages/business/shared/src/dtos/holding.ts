import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';

export type Holding = {
  id: string;
  createdAt: Date;
  tokenId: string;
  userId: string;
  balance: string;
  accountId: string;
  lastUpdated: Date;
};

/**
 * A holding extracted from a file or screenshot — the shape the
 * file-import pipeline (csv/ofx/qif parsers + AI screenshot parsing)
 * produces before the review screen turns it into a real `Holding`.
 *
 * Lives in shared so the worker's return value and the frontend's
 * review page agree on fields. The frontend extends this with
 * `tokenId`, `holdingId`, `clientId` etc. for its own state.
 */
export interface ExtractedHolding {
  /** Currency code (USD, EUR) or stock ticker (AAPL) */
  symbol: string;
  /** Human-readable name */
  name?: string;
  /** Balance as string for decimal precision */
  balance: string;
  /** Confidence 0-1 */
  confidence: number;
  /** Extra context */
  notes?: string;
}

export const CreateHoldingDto = z.object({
  accountId: z.string().uuid(),
  tokenId: z.string().uuid(),
  balance: z.string().refine(
    (val) => {
      if (!isValidDecimalString(val)) return false;
      return new Decimal(val).greaterThanOrEqualTo(0);
    },
    {
      message: 'Balance must be a valid decimal number string that is non-negative',
    }
  ),
  lastUpdated: z.date().optional(),
});

export const UpdateHoldingDto = z.object({
  balance: z
    .string()
    .refine(
      (val) => {
        if (!isValidDecimalString(val)) return false;
        return new Decimal(val).greaterThanOrEqualTo(0);
      },
      {
        message: 'Balance must be a valid decimal number string that is non-negative',
      }
    )
    .optional(),
  isActive: z.boolean().optional(),
});

export type HoldingWithDetails = {
  id: string;
  token: {
    id: string;
    symbol: string;
    name: string;
    type: string;
    typeCode: string;
    iconUrl?: string | null;
    /** 0..1. `>= SCAM_PROBABILITY_THRESHOLD` → rendered with the scam badge. */
    isScamProbability: number;
  };
  amount: number;
  value: number;
  costBasis: number;
  price?: {
    value: string;
    timestamp: string;
    source?: string;
  };
  account: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    institutionId: string;
  };
  institution: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    website?: string | null;
  };
  groups: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  lastUpdated: string;
  createdAt: string;
  isActive: boolean;
  isHidden: boolean;
  source: string;
  apyConfig?: {
    id: string;
    annualRatePct: string;
    payoutFrequency: string;
    payoutDayOfWeek: number | null;
    payoutDayOfMonth: number | null;
    payoutMonth: number | null;
    lastPayoutAt: string | null;
    isActive: boolean;
  };
};

export type HoldingsWithSummary = {
  holdings: HoldingWithDetails[];
  summary: {
    totalCount: number;
    activeCount: number;
    totalValue: string;
  };
};

export type CreateHoldingInput = z.infer<typeof CreateHoldingDto>;
export type UpdateHoldingInput = z.infer<typeof UpdateHoldingDto>;
