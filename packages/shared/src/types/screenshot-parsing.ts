import { z } from 'zod';
import { ProviderValidationInputSchema } from './token-validation';

// Minimal holding structure detected by AI before validation
export const AIDetectedHoldingSchema = z.object({
  symbol: z.string().min(1).max(40),
  name: z.string().max(100).optional(),
  balance: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(1000).optional(),
});

export type AIDetectedHolding = z.infer<typeof AIDetectedHoldingSchema>;

// Parsed holding enriched with validations and DB awareness
export const ParsedHoldingSchema = z.object({
  symbol: z.string().min(1).max(40),
  name: z.string().max(100).optional(),
  balance: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(1000).optional(),
  tokenExists: z.boolean(),
  tokenId: z.string().uuid().optional(),
  existingHoldingId: z.string().uuid().optional(),
  suggestedTokenType: z.string().max(40).optional(),
  errors: z.array(z.string().max(200)).default([]),
  warnings: z.array(z.string().max(200)).default([]),
  requiresUserSelection: z.boolean().optional(),
  providerValidation: ProviderValidationInputSchema.optional(),
});

export type ParsedHolding = z.infer<typeof ParsedHoldingSchema>;

// AI provider response shape
export const AIProviderResponseSchema = z.object({
  portfolio: z.object({
    holdings: z.array(AIDetectedHoldingSchema),
    overallConfidence: z.number().min(0).max(1),
    context: z.string().optional(),
    detectedCurrency: z.string().optional(),
  }),
  metadata: z
    .object({
      model: z.string(),
      tokensUsed: z.number().optional(),
      processingTime: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

export type AIProviderResponse = z.infer<typeof AIProviderResponseSchema>;

export const AccountRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  institutionName: z.string(),
});
export type AccountRef = z.infer<typeof AccountRefSchema>;

export const ParsingSummarySchema = z.object({
  totalHoldings: z.number(),
  existingTokens: z.number(),
  newTokensRequired: z.number(),
  averageConfidence: z.number(),
  hasErrors: z.boolean(),
  hasWarnings: z.boolean(),
});
export type ParsingSummary = z.infer<typeof ParsingSummarySchema>;

export const ScreenshotParsingResultSchema = z.object({
  aiResponse: AIProviderResponseSchema,
  holdings: z.array(ParsedHoldingSchema),
  account: AccountRefSchema,
  summary: ParsingSummarySchema,
});
export type ScreenshotParsingResult = z.infer<typeof ScreenshotParsingResultSchema>;

export const MultipleScreenshotResultSchema = z.object({
  results: z.array(ScreenshotParsingResultSchema),
  combinedHoldings: z.array(ParsedHoldingSchema),
  overallSummary: z.object({
    totalScreenshots: z.number(),
    totalHoldings: z.number(),
    existingTokens: z.number(),
    newTokensRequired: z.number(),
    averageConfidence: z.number(),
    hasErrors: z.boolean(),
    hasWarnings: z.boolean(),
  }),
  account: AccountRefSchema,
});

export type MultipleScreenshotResult = z.infer<typeof MultipleScreenshotResultSchema>;
