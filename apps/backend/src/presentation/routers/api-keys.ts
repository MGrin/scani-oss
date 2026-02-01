import { ApiKeyService } from '@scani/core/services/ApiKeyService';
import { CreateApiKeyDto, RevokeApiKeyDto } from '@scani/shared';
import { Container } from 'typedi';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const apiKeyService = Container.get(ApiKeyService);

export const apiKeysRouter = router({
  // List all API keys for the current user
  list: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await apiKeyService.listApiKeys(dbUser.id);
  }),

  // Create a new API key
  create: protectedProcedure.input(CreateApiKeyDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const apiKeyWithPlaintext = await apiKeyService.createApiKey({
      userId: dbUser.id,
      name: input.name,
      expiresAt: input.expiresAt,
    });

    return {
      id: apiKeyWithPlaintext.id,
      name: apiKeyWithPlaintext.name,
      keyPrefix: apiKeyWithPlaintext.keyPrefix,
      plainKey: apiKeyWithPlaintext.plainKey, // Only returned this once
      expiresAt: apiKeyWithPlaintext.expiresAt,
      createdAt: apiKeyWithPlaintext.createdAt,
    };
  }),

  // Revoke an API key
  revoke: protectedProcedure.input(RevokeApiKeyDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    await apiKeyService.revokeApiKey(dbUser.id, input.id);
    return { success: true };
  }),
});
