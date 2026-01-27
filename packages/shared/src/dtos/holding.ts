import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../utils/financial';

export type Holding = {
  id: string;
  createdAt: Date;
  tokenId: string;
  userId: string;
  balance: string;
  accountId: string;
  lastUpdated: Date;
};

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
};

export type CreateHoldingInput = z.infer<typeof CreateHoldingDto>;
export type UpdateHoldingInput = z.infer<typeof UpdateHoldingDto>;
