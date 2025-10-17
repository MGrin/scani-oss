import { z } from 'zod';

export type Account = {
  name: string;
  description: string | null;
  id: string;
  isActive: boolean;
  typeId: string;
  metadata?: unknown;
  userId: string;
  institutionId: string;
};

export const CreateAccountDto = z.object({
  institutionId: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  typeId: z.string().uuid(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AccountWihSumaryDTO = Account & {
  summary: {
    holdingsCount: number;
    totalValue: string;
  };
};
export type CreateAccountInput = z.infer<typeof CreateAccountDto>;
