import { z } from 'zod';

const selectorId = z.string().uuid().toLowerCase();

export const categorySpendingInputSchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .refine(
        (month) => month >= '1900-01' && month <= new Date().toISOString().slice(0, 7),
        'Choose a month from January 1900 through the current UTC month.'
      ),
    accountId: selectorId.optional(),
    detail: z
      .object({
        tokenId: selectorId,
        category: z.union([z.literal('all'), z.literal('uncategorized'), selectorId]),
        offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CategorySpendingInput = z.infer<typeof categorySpendingInputSchema>;
export interface CategorySpendingRow {
  id: string;
  occurredAt: string;
  quantity: string;
  description: string | null;
  counterparty: string | null;
  accountName: string;
  accountInactive: boolean;
  holdingInactive: boolean;
  tokenId: string;
  symbol: string;
  categoryPath: string | null;
  categoryColor: string | null;
  categorySetBy: string | null;
}
export interface CategorySpendingReport {
  month: string;
  from: string;
  to: string;
  effectiveTo: string;
  generatedAt: string;
  accounts: { id: string; name: string; isActive: boolean }[];
  currencies: {
    tokenId: string;
    symbol: string;
    name: string;
    total: string;
    count: number;
    unreviewedCount: number;
    categories: {
      categoryId: string | null;
      name: string | null;
      color: string | null;
      total: string;
      count: number;
    }[];
  }[];
  excludedSplitCount: number;
  excludedUnclassifiedCount: number;
  detail: {
    categoryName: string | null;
    total: string;
    count: number;
    rows: CategorySpendingRow[];
    nextOffset: number | null;
  } | null;
}
