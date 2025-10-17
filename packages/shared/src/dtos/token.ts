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
