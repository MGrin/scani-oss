import { z } from 'zod';

/**
 * Holding DTOs - Data Transfer Objects for Holding operations
 */

// ============================================================================
// Input DTOs
// ============================================================================

export const CreateHoldingDto = z.object({
  accountId: z.string().uuid(),
  tokenId: z.string().uuid(),
  balance: z.string().refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
    message: 'Balance must be a valid non-negative number string',
  }),
  lastUpdated: z.date().optional(),
});

export const UpdateHoldingDto = z.object({
  balance: z
    .string()
    .refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
      message: 'Balance must be a valid non-negative number string',
    })
    .optional(),
  lastUpdated: z.date().optional(),
});

export const CheckDuplicateHoldingDto = z.object({
  accountId: z.string().uuid(),
  tokenId: z.string().uuid(),
  excludeId: z.string().uuid().optional(),
});

// ============================================================================
// Response DTOs
// ============================================================================

export interface HoldingResponseDto {
  id: string;
  userId: string;
  accountId: string;
  tokenId: string;
  balance: string;
  lastUpdated: Date;
  createdAt: Date;
}

export interface HoldingWithDetailsDto extends HoldingResponseDto {
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  tokenIconUrl: string | null;
  accountName?: string;
  institutionName?: string;
}

export interface HoldingWithValueDto extends HoldingWithDetailsDto {
  currentPrice?: string;
  currentValue?: string;
  baseCurrency?: string;
}

export interface CreateHoldingResultDto {
  holding: HoldingResponseDto;
  priceFetchSuccessful: boolean;
  priceFetchError: string | null;
}

export interface CheckDuplicateResultDto {
  exists: boolean;
  holding: HoldingResponseDto | null;
}

export interface UnpriceableTokenDto {
  tokenId: string;
  symbol: string;
  name: string;
  totalBalance: string;
  accountCount: number;
  providerMetadata?: string;
}

// ============================================================================
// Type exports
// ============================================================================

export type CreateHoldingInput = z.infer<typeof CreateHoldingDto>;
export type UpdateHoldingInput = z.infer<typeof UpdateHoldingDto>;
export type CheckDuplicateHoldingInput = z.infer<typeof CheckDuplicateHoldingDto>;
