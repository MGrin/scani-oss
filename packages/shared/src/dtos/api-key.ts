import { z } from 'zod';

export const CreateApiKeyDto = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  expiresAt: z.date().optional(),
});

export const RevokeApiKeyDto = z.object({
  id: z.string().uuid('Invalid API key ID'),
});

export type CreateApiKeyInput = z.infer<typeof CreateApiKeyDto>;
export type RevokeApiKeyInput = z.infer<typeof RevokeApiKeyDto>;
