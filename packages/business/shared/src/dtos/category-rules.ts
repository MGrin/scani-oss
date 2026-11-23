import { z } from 'zod';

export const categoryRuleDraftSchema = z
  .object({
    payeeText: z
      .string()
      .trim()
      .refine((v) => [...v].length >= 3 && [...v].length <= 200),
    accountId: z.string().uuid(),
    categoryId: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();
export const categoryRuleSaveSchema = categoryRuleDraftSchema
  .extend({
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .refine((v) => !v.id || v.expectedRevision !== undefined);
export const categoryRuleScopeSchema = z
  .object({
    accountId: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to));
export type CategoryRuleDraft = z.infer<typeof categoryRuleDraftSchema>;
export type CategoryRuleSave = z.infer<typeof categoryRuleSaveSchema>;
export type SavedCategoryRule = {
  id: string;
  payeeKey: string;
  accountId: string;
  categoryId: string;
  enabled: boolean;
  revision: number;
};
export type RuleScope = z.infer<typeof categoryRuleScopeSchema>;
export type RulePreviewRow = {
  transactionId: string;
  occurredAt: string;
  payee: string;
  amount: string;
  currency: string;
  beforeCategoryId: string | null;
  beforeCategoryLabel: string | null;
  afterCategoryId: string;
  afterCategoryLabel: string;
  ruleId: string;
  rulePayeeKey: string;
  provenanceOnly: boolean;
  beforeCategoryColor: string | null;
  afterCategoryColor: string | null;
};
export type RulePreview = {
  previewId: string;
  expiresAt: string;
  scope: RuleScope;
  accountName: string;
  matched: number;
  protected: number;
  unchanged: number;
  changed: number;
  rows: RulePreviewRow[];
};
export type RuleApplyResult = { operationId: string; changed: number; replayed: boolean };
export type RuleUndoResult = { operationId: string; restored: number; replayed: boolean };
export type RuleOperationSummary = {
  operationId: string;
  status: 'applied' | 'undone';
  changed: number;
  appliedAt: string;
  undoneAt: string | null;
};
export type RuleRecentOperations = { items: RuleOperationSummary[] };
