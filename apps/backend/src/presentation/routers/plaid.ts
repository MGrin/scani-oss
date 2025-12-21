/**
 * Plaid Integration Router
 * Handles Plaid Link token creation, token exchange, and account import
 */

import {
  CreatePlaidLinkTokenUseCase,
  ExchangePlaidTokenUseCase,
  ImportPlaidAccountsUseCase,
  SyncPlaidBalancesUseCase,
} from '@scani/core/use-cases';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

/**
 * Plaid integration router
 */
export const plaidRouter = router({
  /**
   * Create Plaid Link token for frontend integration
   * This token is used by the Plaid Link component to initiate OAuth flow
   */
  createLinkToken: protectedProcedure
    .input(
      z.object({
        plaidInstitutionId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      try {
        const createLinkTokenUseCase = Container.get(CreatePlaidLinkTokenUseCase);
        const result = await createLinkTokenUseCase.execute({
          userId,
          plaidInstitutionId: input.plaidInstitutionId,
        });

        return {
          success: true,
          linkToken: result.linkToken,
          expiration: result.expiration,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create Plaid Link token',
          cause: error,
        });
      }
    }),

  /**
   * Exchange Plaid public token for access token
   * Called after user completes Plaid Link flow
   * Also creates/updates institution mapping
   */
  exchangePublicToken: protectedProcedure
    .input(
      z.object({
        publicToken: z.string().min(1, 'Public token is required'),
        plaidInstitutionId: z.string().min(1, 'Institution ID is required'),
        institutionName: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      try {
        const exchangeTokenUseCase = Container.get(ExchangePlaidTokenUseCase);
        const result = await exchangeTokenUseCase.execute({
          userId,
          publicToken: input.publicToken,
          plaidInstitutionId: input.plaidInstitutionId,
          institutionName: input.institutionName,
        });

        // Automatically import accounts and balances
        const importAccountsUseCase = Container.get(ImportPlaidAccountsUseCase);
        const importResult = await importAccountsUseCase.execute({
          userId,
          plaidItemId: result.plaidItemId,
        });

        return {
          success: true,
          plaidItemId: result.plaidItemId,
          institutionId: result.institutionId,
          institutionCreated: result.institutionCreated,
          accountsCreated: importResult.accountsCreated,
          holdingsImported: importResult.holdingsImported,
          errors: importResult.errors,
        };
      } catch (error) {
        // Extract detailed error message from Plaid API if available
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to exchange Plaid token';
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: errorMessage,
          cause: error,
        });
      }
    }),

  /**
   * Import accounts and balances for a Plaid item
   * Can be called manually to re-import accounts
   */
  importAccounts: protectedProcedure
    .input(
      z.object({
        plaidItemId: z.string().min(1, 'Plaid item ID is required'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      try {
        const importAccountsUseCase = Container.get(ImportPlaidAccountsUseCase);
        const result = await importAccountsUseCase.execute({
          userId,
          plaidItemId: input.plaidItemId,
        });

        return {
          success: true,
          accounts: result.accounts,
          holdings: result.holdings,
          accountsCreated: result.accountsCreated,
          holdingsImported: result.holdingsImported,
          errors: result.errors,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to import Plaid accounts',
          cause: error,
        });
      }
    }),

  /**
   * Sync balances for user's Plaid items
   * Updates balances for all connected accounts
   */
  syncBalances: protectedProcedure
    .input(
      z.object({
        plaidItemId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      try {
        const syncBalancesUseCase = Container.get(SyncPlaidBalancesUseCase);
        const result = await syncBalancesUseCase.execute({
          userId,
          plaidItemId: input.plaidItemId,
        });

        return {
          success: true,
          itemsSynced: result.itemsSynced,
          accountsUpdated: result.accountsUpdated,
          holdingsUpdated: result.holdingsUpdated,
          errors: result.errors,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to sync Plaid balances',
          cause: error,
        });
      }
    }),
});
