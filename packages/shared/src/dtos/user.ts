import { z } from 'zod';

export const UpdateUserDto = z.object({
  name: z.string().min(1).optional(),
  avatar: z.string().url().nullable().optional(),
  baseCurrencyId: z.string().uuid().nullable().optional(),
});

export type UpdateUserInput = z.infer<typeof UpdateUserDto>;
