/**
 * Wallet Router
 * Handles crypto wallet import operations
 */

import { Container } from 'typedi';
import { z } from 'zod';
import { ImportWalletAddressUseCase } from '../../application/use-cases';
import { BlockchainServiceManager } from '../../infrastructure/external-services/blockchain';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const blockchainService = Container.get(BlockchainServiceManager);

/**
 * Input validation schema for wallet import
 */
const ImportWalletSchema = z.object({
  address: z.string().min(1, 'Wallet address is required').max(200, 'Wallet address is too long'),
  displayName: z.string().max(100, 'Display name is too long').optional(),
});

export const walletRouter = router({
  /**
   * Get all supported blockchain chains
   */
  getSupportedChains: protectedProcedure.query(async () => {
    const chains = blockchainService.getAllSupportedChains();

    return chains.map((chain) => ({
      chainId: chain.chainId,
      name: chain.name,
      type: chain.type,
      nativeSymbol: chain.nativeSymbol,
      nativeName: chain.nativeName,
      isActive: chain.isActive,
    }));
  }),

  /**
   * Import a wallet address
   * Detects chains, fetches balances, creates accounts and holdings
   */
  importAddress: protectedProcedure.input(ImportWalletSchema).mutation(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);

    // Execute wallet import use case
    const importUseCase = Container.get(ImportWalletAddressUseCase);
    const result = await importUseCase.execute(input, dbUser.id);

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
    .mutation(async ({ input }) => {
      const detectedChains = await blockchainService.detectWalletChains(input.address);

      // Get chain details for detected chains
      const chains = blockchainService.getAllSupportedChains();
      const detectedChainDetails = chains
        .filter((chain) => detectedChains.includes(chain.chainId))
        .map((chain) => ({
          chainId: chain.chainId,
          name: chain.name,
          type: chain.type,
          nativeSymbol: chain.nativeSymbol,
        }));

      return {
        address: input.address,
        chainsDetected: detectedChainDetails,
        totalChains: detectedChainDetails.length,
      };
    }),
});
