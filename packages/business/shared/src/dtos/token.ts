import { z } from 'zod';

export type Token = {
  symbol: string;
  name: string;
  id: string;
  isActive: boolean;

  typeId: string;
  decimals: number;
  iconUrl: string | null;
  providerMetadata: string;
};

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

export type CreateTokenInput = z.infer<typeof CreateTokenDto>;

// Custom token: shared-by-all asset whose price is manually set (e.g.
// private company shares). Distinct from CreateTokenDto's private path
// so the schema matches the dedicated tokens.createCustom mutation
// exactly and isn't reused with optional fields that don't apply.
export const CreateCustomTokenDto = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .transform((val) => val.toUpperCase()),
  name: z.string().min(1).max(200),
  typeCode: z.enum(['private-company', 'other']),
  manualPrice: z.number().positive(),
  baseCurrencyCode: z
    .string()
    .min(1)
    .max(10)
    .transform((val) => val.toUpperCase()),
  priceDescription: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  decimals: z.number().int().min(0).max(18).default(2),
  iconUrl: z.string().url().optional(),
});

export type CreateCustomTokenInput = z.infer<typeof CreateCustomTokenDto>;

export const UpdateCustomPriceDto = z.object({
  tokenId: z.string().uuid(),
  newPrice: z.number().positive(),
  baseCurrencyCode: z
    .string()
    .min(1)
    .max(10)
    .transform((val) => val.toUpperCase()),
  reason: z.string().min(1).max(500).optional(),
});

export type UpdateCustomPriceInput = z.infer<typeof UpdateCustomPriceDto>;
