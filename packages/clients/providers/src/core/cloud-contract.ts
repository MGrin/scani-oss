import type { Token } from '@scani/db/schema';
import { z } from 'zod';

const identifier = z.string().min(1).max(256);
export const cloudMetadataSchema = z
  .object({
    coingecko: z.object({ id: identifier, symbol: identifier.optional() }).strict().optional(),
    defillama: z.object({ coin: identifier }).strict().optional(),
    etherscan: z
      .object({ chainId: z.number().int().positive(), contractAddress: identifier.optional() })
      .strict()
      .optional(),
    solana: z.object({ mint: identifier }).strict().optional(),
    kraken: z.object({ asset: identifier }).strict().optional(),
    finnhub: z.object({ symbol: identifier, exchange: identifier.optional() }).strict().optional(),
  })
  .strict();

export const cloudAssetSchema = z
  .object({
    id: identifier,
    symbol: identifier,
    name: z.string().max(512),
    typeId: identifier,
    decimals: z.number().int().min(0).max(255).nullable().optional(),
    marketSegment: z.string().max(64).nullable().optional(),
    providerMetadata: cloudMetadataSchema.optional(),
  })
  .strict();

export const cloudPricingProviderSchema = z.enum([
  'defillama',
  'frankfurter',
  'coingecko',
  'finnhub',
  'yahoo-finance',
  'kraken',
]);
/**
 * Pricing providers the cloud serves only to Scani's own keys (SC-1586).
 * Yahoo's terms forbid commercial reuse and redistribution, so a Cloud API
 * key is never served its prices and a Tier 2 install never asks for them.
 */
export const SCANI_ONLY_CLOUD_PRICING: ReadonlySet<string> = new Set(['yahoo-finance']);

export const cloudPricesInput = z
  .object({
    provider: cloudPricingProviderSchema,
    tokens: z.array(cloudAssetSchema).min(1).max(100),
    baseCurrency: cloudAssetSchema,
    at: z.string().datetime().optional(),
  })
  .strict();
export const cloudRangeInput = z
  .object({
    provider: cloudPricingProviderSchema,
    token: cloudAssetSchema,
    baseCurrency: cloudAssetSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .strict()
  .refine(({ from, to }) => {
    const span = Date.parse(to) - Date.parse(from);
    return span >= 0 && span <= 366 * 86_400_000;
  }, 'A range must be ordered and at most 366 days');

export const cloudAiInput = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('screenshot'),
      imageBase64: z
        .string()
        .min(4)
        .max(14_000_000)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']),
      hint: z.string().max(16_000).optional(),
      systemPrompt: z.string().max(32_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('document'),
      text: z.string().min(1).max(250_000),
      hint: z.string().max(16_000).optional(),
      systemPrompt: z.string().max(32_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('complete'),
      prompt: z.string().min(1).max(64_000),
      maxTokens: z.number().int().min(1).max(16_384).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .strict(),
]);

export const cloudWalletInput = z
  .object({
    operation: z.enum(['balances', 'transactions', 'exited', 'probe', 'activity', 'resolve']),
    institutionCode: z.string().min(1).max(64),
    address: z.string().min(1).max(256),
    baseCurrency: cloudAssetSchema,
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    externalIds: z.array(identifier).max(20).optional(),
  })
  .strict()
  .refine(({ since, until }) => !since || !until || since <= until, 'Invalid history range');

// Explicit projection prevents local ownership fields and future credential namespaces
// from hitching a ride when the database's token shape grows.
export function toCloudAsset(token: Token): z.infer<typeof cloudAssetSchema> {
  const metadata =
    typeof token.providerMetadata === 'string'
      ? JSON.parse(token.providerMetadata)
      : token.providerMetadata;
  const providerMetadata = cloudMetadataSchema.strip().parse(metadata ?? {});
  return cloudAssetSchema.parse({
    id: token.id,
    symbol: token.symbol,
    name: token.name,
    typeId: token.typeId,
    decimals: token.decimals,
    marketSegment: token.marketSegment,
    providerMetadata,
  });
}

export function fromCloudAsset(asset: z.infer<typeof cloudAssetSchema>): Token {
  return {
    ...asset,
    decimals: asset.decimals ?? null,
    decimalsSource: null,
    marketSegment: asset.marketSegment ?? null,
    providerMetadata: asset.providerMetadata ?? {},
    iconUrl: null,
    isActive: true,
    isScamProbability: 0,
    scamScoreVersion: null,
    scamScoreSource: 'heuristic',
    lookalikeOf: null,
    createdByUserId: null,
    unpriceableUntil: null,
    lastPricingAttemptAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
