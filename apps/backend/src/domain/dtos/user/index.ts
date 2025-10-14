import { z } from 'zod';

export const CreateUserDto = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  avatar: z.string().url().optional(),
  baseCurrencyId: z.string().uuid().optional(),
});

export const UpdateUserDto = z.object({
  name: z.string().min(1).optional(),
  avatar: z.string().url().nullable().optional(),
  baseCurrencyId: z.string().uuid().nullable().optional(),
});

export interface UserResponseDto {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  baseCurrencyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioValueDto {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    currentPrice?: string;
    value?: string;
  }>;
}

export type CreateUserInput = z.infer<typeof CreateUserDto>;
export type UpdateUserInput = z.infer<typeof UpdateUserDto>;
