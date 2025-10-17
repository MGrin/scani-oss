import { z } from 'zod';

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
  balance: z.string().refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
    message: 'Balance must be a valid non-negative number string',
  }),
  lastUpdated: z.date().optional(),
});

export const UpdateHoldingDto = z.object({
  balance: z.string().refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
    message: 'Balance must be a valid non-negative number string',
  }),
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
  lastUpdated: string;
  createdAt: string;
};

export type CreateHoldingInput = z.infer<typeof CreateHoldingDto>;
export type UpdateHoldingInput = z.infer<typeof UpdateHoldingDto>;
