import z from 'zod';

export const IdInputDto = z.object({
  id: z.string().uuid(),
});
