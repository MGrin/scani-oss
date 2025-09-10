import { z } from 'zod';

// Transaction types
export const TransactionType = z.enum(['income', 'expense', 'transfer']);

// Categories for transactions
export const TransactionCategory = z.enum([
  'food',
  'transportation',
  'housing',
  'healthcare',
  'entertainment',
  'shopping',
  'utilities',
  'income',
  'investment',
  'other',
]);

// Transaction schema
export const TransactionSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  type: TransactionType,
  category: TransactionCategory,
  description: z.string(),
  date: z.date(),
  accountId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Account schema
export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['checking', 'savings', 'credit', 'investment']),
  balance: z.number(),
  currency: z.string().default('USD'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Budget schema
export const BudgetSchema = z.object({
  id: z.string(),
  category: TransactionCategory,
  amount: z.number().positive(),
  period: z.enum(['weekly', 'monthly', 'yearly']),
  spent: z.number().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Input schemas for API
export const CreateTransactionSchema = TransactionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateAccountSchema = AccountSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateBudgetSchema = BudgetSchema.omit({
  id: true,
  spent: true,
  createdAt: true,
  updatedAt: true,
});

// TypeScript types
export type Transaction = z.infer<typeof TransactionSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type CreateTransaction = z.infer<typeof CreateTransactionSchema>;
export type CreateAccount = z.infer<typeof CreateAccountSchema>;
export type CreateBudget = z.infer<typeof CreateBudgetSchema>;
