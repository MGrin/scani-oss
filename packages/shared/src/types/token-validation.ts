import { z } from 'zod';

// Provider identifiers for external token validation
export const TokenProviderSchema = z.enum(['finnhub', 'coingecko']);
export type TokenProvider = z.infer<typeof TokenProviderSchema>;

// Token metadata returned by external providers (not the DB Token)
// Keep "type" flexible because token types are dynamic in the app.
export const TokenMetadataSchema = z.object({
  symbol: z.string().min(1).max(40),
  name: z.string().min(1).max(100),
  type: z.string().min(1), // dynamic; do not hardcode enums here
  currency: z.string().min(1).max(10).optional(),
  exchange: z.string().max(40).optional(),
  description: z.string().max(200).optional(),
  provider: TokenProviderSchema,
  providerMetadata: z.record(z.unknown()).default({}),
});
export type TokenMetadata = z.infer<typeof TokenMetadataSchema>;

// Result of validating a token against external providers
export const TokenValidationResultSchema = z.object({
  isValid: z.boolean(),
  metadata: TokenMetadataSchema.optional(),
  error: z.string().optional(),
});
export type TokenValidationResult = z.infer<typeof TokenValidationResultSchema>;

// Optional provider validation bundle (exact + similar + empty state)
export const ProviderValidationSchema = z.object({
  exactMatch: TokenValidationResultSchema.optional(),
  similarMatches: z.array(TokenValidationResultSchema).max(50).optional(),
  noMatches: z.boolean().optional(),
});
export type ProviderValidation = z.infer<typeof ProviderValidationSchema>;

// Looser input schemas for accepting minimal provider metadata from clients/parsers
export const LooseTokenMetadataSchema = z.object({
  symbol: z.string().min(1).max(40),
  name: z.string().min(1).max(100),
  type: z.string().min(1),
  currency: z.string().min(1).max(10).optional(),
  exchange: z.string().max(40).optional(),
  description: z.string().max(200).optional(),
  provider: z.string().min(1), // accept any string in input; sanitize later
  providerMetadata: z.record(z.unknown()).optional(),
});
export type LooseTokenMetadata = z.infer<typeof LooseTokenMetadataSchema>;

export const LooseTokenValidationResultSchema = z.object({
  isValid: z.boolean(),
  metadata: LooseTokenMetadataSchema.optional(),
  error: z.string().optional(),
});
export type LooseTokenValidationResult = z.infer<typeof LooseTokenValidationResultSchema>;

export const ProviderValidationInputSchema = z.object({
  exactMatch: LooseTokenValidationResultSchema.optional(),
  similarMatches: z.array(LooseTokenValidationResultSchema).max(50).optional(),
  noMatches: z.boolean().optional(),
});
export type ProviderValidationInput = z.infer<typeof ProviderValidationInputSchema>;
