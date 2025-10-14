import { z } from 'zod';
import { CreateHoldingDto } from '../holding';
import { CreateTokenPriceDto } from '../token-price';

/**
 * Batch Operations DTOs - for atomic multi-entity operations
 */

export const BatchCreateHoldingsDto = z.object({
  holdings: z.array(CreateHoldingDto),
  skipDuplicates: z.boolean().default(false),
});

export const BatchUpdatePricesDto = z.object({
  prices: z.array(CreateTokenPriceDto),
  overwriteExisting: z.boolean().default(true),
});

export const ImportPortfolioDto = z.object({
  institutionId: z.string().uuid(),
  accountName: z.string().min(1),
  accountTypeCode: z.string().min(1),
  holdings: z.array(
    z.object({
      tokenSymbol: z.string(),
      balance: z.string(),
      createTokenIfMissing: z.boolean().default(false),
    })
  ),
});

export interface BatchOperationResultDto<T = unknown> {
  success: boolean;
  totalProcessed: number;
  successCount: number;
  failureCount: number;
  results: Array<{
    success: boolean;
    data?: T;
    error?: string;
  }>;
  errors: string[];
}

export interface ImportPortfolioResultDto {
  success: boolean;
  accountId: string;
  holdingsCreated: number;
  tokensCreated: number;
  errors: string[];
}

export type BatchCreateHoldingsInput = z.infer<typeof BatchCreateHoldingsDto>;
export type BatchUpdatePricesInput = z.infer<typeof BatchUpdatePricesDto>;
export type ImportPortfolioInput = z.infer<typeof ImportPortfolioDto>;
