import { z } from 'zod';

export const CreateInstitutionDto = z.object({
  name: z.string().min(1).max(200),
  typeId: z.string().uuid(),
  description: z.string().max(500).optional(),
  website: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
});

export type CreateInstitutionInput = z.infer<typeof CreateInstitutionDto>;
