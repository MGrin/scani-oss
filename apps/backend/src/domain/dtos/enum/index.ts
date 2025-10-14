import { z } from 'zod';

/**
 * Enum DTOs - for Institution Types, Account Types, Transaction Types, Token Types
 */

export const CreateEnumDto = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  displayOrder: z.number().default(0),
  isActive: z.boolean().default(true),
});

export const UpdateEnumDto = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  displayOrder: z.number().optional(),
  isActive: z.boolean().optional(),
});

export interface EnumResponseDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateEnumInput = z.infer<typeof CreateEnumDto>;
export type UpdateEnumInput = z.infer<typeof UpdateEnumDto>;
