import { z } from 'zod';

export const CreateInstitutionDto = z.object({
  name: z.string().min(1).max(200),
  typeCode: z.string().min(1),
  description: z.string().max(500).optional(),
  website: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
});

export const UpdateInstitutionDto = z.object({
  name: z.string().min(1).max(200).optional(),
  typeCode: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  website: z.string().url().nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
});

export interface InstitutionResponseDto {
  id: string;
  name: string;
  typeId: string;
  type: string | null;
  typeName: string | null;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateInstitutionInput = z.infer<typeof CreateInstitutionDto>;
export type UpdateInstitutionInput = z.infer<typeof UpdateInstitutionDto>;
