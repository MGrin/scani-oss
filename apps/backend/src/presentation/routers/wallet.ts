/**
 * Wallet Router
 *
 * Handles crypto wallet import - creates accounts and holdings for wallet addresses.
 * Refactored to use WalletService with dependency injection.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { WalletService } from "../../application/services";
import { getUserId } from "../middleware/auth";
import { protectedProcedure, router } from "../trpc";

/**
 * Factory function to create wallet router with injected dependencies
 */
export function createWalletRouter(walletService: WalletService) {
  return router({
    /**
     * Import wallet address - creates accounts and holdings for all chains with balances
     *
     * Delegates to WalletService for all blockchain integration and business logic.
     */
    importWalletAddress: protectedProcedure
      .input(
        z.object({
          walletAddress: z.string().min(1, "Wallet address is required"),
          accountName: z.string().optional(), // Optional custom name
        })
      )
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);

        try {
          return await walletService.importWalletAddress(
            {
              walletAddress: input.walletAddress,
              accountName: input.accountName,
            },
            userId
          );
        } catch (error) {
          // Map service errors to tRPC errors
          if (error instanceof Error) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: error.message,
            });
          }
          throw error;
        }
      }),
  });
}
