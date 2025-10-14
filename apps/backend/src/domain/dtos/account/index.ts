import { z } from 'zod';

export const CreateAccountDto = z.object({
  institutionId: z.string().uuid(),
  name: z.string().min(1).max(100),
  typeCode: z.string().min(1),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateAccountDto = z.object({
  name: z.string().min(1).max(100).optional(),
  typeCode: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

export interface AccountResponseDto {
  id: string;
  userId: string;
  institutionId: string;
  name: string;
  typeId: string;
  type: string | null;
  typeName: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountWithBalanceDto extends AccountResponseDto {
  totalBalance: number;
  holdingsCount: number;
  institutionName?: string;
}

export interface AccountSummaryDto {
  accounts: AccountWithBalanceDto[];
  typesSummary: Array<{
    type: string;
    typeName: string;
    accountCount: number;
    totalBalance: number;
  }>;
  totalBalance: number;
  totalAccounts: number;
}

export type CreateAccountInput = z.infer<typeof CreateAccountDto>;
export type UpdateAccountInput = z.infer<typeof UpdateAccountDto>;
