import { z } from 'zod';

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
