/**
 * Wallet Router
 * Handles crypto wallet import operations
 */

import { WalletImplementations } from '@scani/core/features/implementations';
import { createComponentLogger } from '@scani/core/utils/logger';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const logger = createComponentLogger('router:wallet');

/**
 * Input validation schema for wallet import
 */
const ImportWalletSchema = z.object({
  address: z.string().min(1, 'Wallet address is required').max(200, 'Wallet address is too long'),
  displayName: z.string().max(100, 'Display name is too long').optional(),
  detectedInstitutionIds: z.array(z.string().uuid()).optional(),
});

export const walletRouter = router({
  /**
   * Get all supported blockchain chains
   */
  getSupportedChains: protectedProcedure.query(async ({ ctx }) => {
    return await WalletImplementations.getSupportedChains({ userId: ctx.userId }, {});
  }),

  /**
   * Import a wallet address
   * Detects chains, fetches balances, creates accounts and holdings
   */
  importAddress: protectedProcedure.input(ImportWalletSchema).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await WalletImplementations.importAddress({ userId: dbUser.id, dbUser }, input);

    // Log the final result for debugging
    logger.info(
      {
        userId: dbUser.id,
        accountsCreated: result.accounts.length,
        holdingsCreated: result.holdings.length,
        chainsDetected: result.chainsDetected,
        errorsCount: result.errors.length,
        hasErrors: result.errors.length > 0,
        hasSuccess: result.accounts.length > 0 || result.holdings.length > 0,
      },
      'Wallet import completed - returning result to client'
    );

    // If we couldn't pick up anything at all, surface that as a proper
    // error rather than a silent 200 OK with empty arrays — otherwise the
    // frontend toast reads "No chains" and the user has no way to tell
    // whether the address is a mistyped hex string, an empty-but-valid
    // wallet, or (most commonly) a missing Etherscan/Polygonscan API key
    // causing every chain probe to 401-out. The message covers all three
    // cases and nudges toward the real fix.
    if (result.chainsDetected === 0 && result.accounts.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message:
          'No wallet activity found on any supported chain. Check the address, or add blockchain-explorer API keys (ETHERSCAN_API_KEY, etc.) if the backend is missing them.',
      });
    }

    // Emit WebSocket events for created entities
    for (const account of result.accounts) {
      emitEntityChange({
        type: 'entity_changed',
        entityType: 'account',
        operationType: 'create',
        entityId: account.id,
        userId: dbUser.id,
        data: {
          institutionId: account.institutionId,
          name: account.name,
        },
      });
    }

    for (const holding of result.holdings) {
      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'create',
        entityId: holding.id,
        userId: dbUser.id,
        data: {
          accountId: holding.accountId,
        },
      });
    }

    // Also emit entity change for portfolio sync
    if (result.holdings.length > 0) {
      emitEntityChange({
        type: 'sync',
        entityType: 'holding',
        userId: dbUser.id,
        data: {
          reason: 'wallet_import',
          holdingsAffected: result.holdings.length,
        },
      });
    }

    return result;
  }),

  /**
   * Detect which chains a wallet address exists on
   * Useful for preview before import
   */
  detectChains: protectedProcedure
    .input(
      z.object({
        address: z
          .string()
          .min(1, 'Wallet address is required')
          .max(200, 'Wallet address is too long'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await WalletImplementations.detectChains({ userId: ctx.userId }, input);
      // Same pattern as importAddress: an empty chainsDetected is often a
      // config-level error (missing explorer API keys) dressed up as a
      // normal 200. Surface it so the UI can tell the user something
      // actionable instead of "no chains found, good luck."
      if (result.totalChains === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message:
            'No wallet activity found on any supported chain. Check the address, or add blockchain-explorer API keys (ETHERSCAN_API_KEY, etc.) if the backend is missing them.',
        });
      }
      return result;
    }),
});
