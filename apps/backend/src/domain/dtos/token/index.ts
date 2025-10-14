import { z } from 'zod';

/**
 * Token DTOs - Data Transfer Objects for Token operations
 *
 * These DTOs define the structure for creating, updating, and responding with token data.
 * They include proper validation and type safety.
 */

// ============================================================================
// Input DTOs
// ============================================================================

export const CreateTokenDto = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  name: z.string().min(1).max(100).optional(),
  typeId: z.string().uuid().optional(), // For existing type ID
  typeCode: z.string().optional(), // For type code lookup
  decimals: z.number().int().min(0).max(18).default(2),
  iconUrl: z.string().url().optional(),
  isActive: z.boolean().default(true),

  // For private tokens
  manualPrice: z.number().positive().optional(),
  priceDescription: z.string().optional(),
  description: z.string().optional(),

  // For external tokens - specify exact CoinGecko ID when user selected specific token
  coinGeckoId: z.string().min(1).max(100).optional(),

  // Provider metadata structure
  providerMetadata: z
    .object({
      provider: z.enum(['manual', 'coingecko', 'finnhub', 'defillama']),
      coingecko: z
        .object({
          id: z.string(),
          symbol: z.string(),
          name: z.string(),
        })
        .optional(),
      finnhub: z
        .object({
          symbol: z.string(),
          name: z.string(),
          type: z.string(),
        })
        .optional(),
      validatedAt: z.string().optional(),
    })
    .optional(),
});

export const UpdateTokenDto = z.object({
  name: z.string().min(1).max(100).optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  iconUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
  manualPrice: z.number().positive().optional(),
  priceDescription: z.string().optional(),
  providerMetadata: z.string().optional(), // JSON string
});

export const TokenSearchDto = z.object({
  query: z.string().min(1).max(20),
  limit: z.number().int().min(1).max(50).default(10),
  typeCode: z.string().optional(),
});

export const ValidateTokenDto = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  typeCode: z.string().optional(),
});

export const ValidateTokenByCoinGeckoIdDto = z.object({
  coinGeckoId: z.string().min(1).max(100),
});

// ============================================================================
// Response DTOs
// ============================================================================

export interface TokenResponseDto {
  id: string;
  symbol: string;
  name: string;
  typeId: string;
  type: string | null;
  typeName: string | null;
  decimals: number;
  iconUrl: string | null;
  isActive: boolean;
  providerMetadata?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenWithPriceDto extends TokenResponseDto {
  currentPrice?: string;
  priceTimestamp?: Date;
  priceSource?: string;
  baseCurrency?: string;
}

export interface TokenWithTotalValueDto extends TokenResponseDto {
  totalBalance: string;
  totalValueInBaseCurrency: string;
  baseCurrencySymbol: string;
}

export interface TokenValidationResponseDto {
  isValid: boolean;
  error?: string;
  metadata?: {
    symbol: string;
    name: string;
    type: string;
    currency?: string;
    exchange?: string;
    provider: 'finnhub' | 'coingecko';
    providerMetadata?: Record<string, unknown>;
  };
  existsInDatabase?: boolean;
  existingToken?: {
    id: string;
    symbol: string;
    name: string;
    isActive: boolean;
  } | null;
}

export interface TokenSearchResultDto {
  id?: string;
  symbol: string;
  name: string;
  typeId?: string;
  type?: string | null;
  typeName?: string | null;
  decimals?: number;
  iconUrl?: string | null;
  isActive?: boolean;
  source: 'database' | 'external';
  provider?: 'finnhub' | 'coingecko';
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Type exports
// ============================================================================

export type CreateTokenInput = z.infer<typeof CreateTokenDto>;
export type UpdateTokenInput = z.infer<typeof UpdateTokenDto>;
export type TokenSearchInput = z.infer<typeof TokenSearchDto>;
export type ValidateTokenInput = z.infer<typeof ValidateTokenDto>;
export type ValidateTokenByCoinGeckoIdInput = z.infer<typeof ValidateTokenByCoinGeckoIdDto>;
