import { z } from 'zod';

export const MobileToken = z.object({ id: z.string(), symbol: z.string(), name: z.string() });
export type MobileTokenT = z.infer<typeof MobileToken>;

export const MobileAccount = z.object({
  id: z.string(),
  name: z.string(),
  typeId: z.string(),
  institutionId: z.string().nullable(),
  totalValue: z.string(),
});

export const MobileHolding = z.object({
  id: z.string(),
  accountId: z.string(),
  symbol: z.string(),
  name: z.string(),
  amount: z.string(),
  value: z.string().nullable(),
});

export const MobileGroup = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

export type MobileGroupT = z.infer<typeof MobileGroup>;

export const MobileVault = z.object({
  id: z.string(),
  name: z.string(),
  targetAmount: z.string(),
  currentAmount: z.string(),
  currencyId: z.string(),
  color: z.string(),
  iconName: z.string().nullable(),
  description: z.string().nullable(),
});

export type MobileVaultT = z.infer<typeof MobileVault>;
