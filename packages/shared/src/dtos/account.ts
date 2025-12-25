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
  groups: Array<{
    id: string;
    name: string;
    color?: string;
  }>;
};
export type CreateAccountInput = z.infer<typeof CreateAccountDto>;

export const UpdateAccountDto = z.object({
  name: z.string().min(1).max(100).optional(),
  typeId: z.string().uuid().optional(),
  institutionId: z.string().uuid().optional(),
  description: z.string().max(500).optional().nullable(),
});

export type UpdateAccountInput = z.infer<typeof UpdateAccountDto>;
