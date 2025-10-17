import { z } from 'zod';

export type Institution = {
  name: string;
  description: string | null;
  id: string;
  isActive: boolean;
  typeId: string;
  website: string | null;
  logoUrl: string | null;
};

export const CreateInstitutionDto = z.object({
  name: z.string().min(1).max(200),
  typeId: z.string().uuid(),
  description: z.string().max(500).optional(),
  website: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
});

export type CreateInstitutionInput = z.infer<typeof CreateInstitutionDto>;
