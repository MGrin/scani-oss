import { CreateInstitutionSchema } from '@scani/shared/types';
import Decimal from 'decimal.js';
import ogs from 'open-graph-scraper';
import { Container } from 'typedi';
import { z } from 'zod';
import type { InstitutionService } from '../../application/services/InstitutionService';
import type { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { getUserId } from '../../middleware/auth';
import { protectedProcedure, router } from '../trpc';

/**
 * Factory function to create the institutions router with injected dependencies
 */
export function createInstitutionsRouter(
  institutionRepository: InstitutionRepository,
  institutionService: InstitutionService
) {
  return router({
    // Get all institutions
    getAll: protectedProcedure.query(async () => {
      const institutions = await institutionRepository.findAll();
      return institutions;
    }),

    getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
      const institution = await institutionRepository.findById(input.id);
      return institution ?? null;
    }),

    // Get institutions where the current user has accounts
    getByUserId: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);
      const institutions = await institutionRepository.findByUserId(userId);
      return institutions;
    }),

    // Get institutions with summary data (account count, total value)
    getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);

      // Get user's institutions
      const institutions = await institutionRepository.findByUserId(userId);

      if (institutions.length === 0) {
        return [];
      }

      // Get all accounts for this user
      const { AccountRepository } = await import(
        '../../infrastructure/repositories/AccountRepository'
      );
      const accountRepository = Container.get(AccountRepository);
      const accounts = await accountRepository.findByUser(userId);

      // Get all holdings for this user
      const { HoldingRepository } = await import(
        '../../infrastructure/repositories/HoldingRepository'
      );
      const holdingRepository = Container.get(HoldingRepository);
      const holdings = await holdingRepository.findByUser(userId);

      // Get portfolio valuation for value calculations
      const { PortfolioValuationService } = await import(
        '../../application/services/PortfolioValuationService'
      );
      const portfolioService = Container.get(PortfolioValuationService);
      const portfolioValue = await portfolioService.getUserPortfolioValue(userId);

      // Create maps for efficient lookups
      const holdingsByAccount = new Map<string, typeof holdings>();
      for (const holding of holdings) {
        if (!holdingsByAccount.has(holding.accountId)) {
          holdingsByAccount.set(holding.accountId, []);
        }
        holdingsByAccount.get(holding.accountId)!.push(holding);
      }

      const accountsByInstitution = new Map<string, typeof accounts>();
      for (const account of accounts) {
        if (!accountsByInstitution.has(account.institutionId)) {
          accountsByInstitution.set(account.institutionId, []);
        }
        accountsByInstitution.get(account.institutionId)!.push(account);
      }

      // Create value map from portfolio data (token symbol -> total value for that token)
      const valueMap = new Map(portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || '0']));

      // Get token repository to map holding tokenIds to symbols
      const { TokenRepository } = await import('../../infrastructure/repositories/TokenRepository');
      const tokenRepository = Container.get(TokenRepository);
      const tokenIds = [...new Set(holdings.map((h) => h.tokenId))];
      const tokens = await tokenRepository.findByIds(tokenIds);
      const tokenMap = new Map(tokens.map((t) => [t.id, t]));

      // Build summary for each institution
      const institutionsWithSummary = institutions.map((institution) => {
        const institutionAccounts = accountsByInstitution.get(institution.id) || [];
        const accountCount = institutionAccounts.length;

        // Calculate total value across all accounts in this institution
        let totalValue = new Decimal(0);
        for (const account of institutionAccounts) {
          const accountHoldings = holdingsByAccount.get(account.id) || [];
          for (const holding of accountHoldings) {
            const token = tokenMap.get(holding.tokenId);
            if (token) {
              const holdingValue = valueMap.get(token.symbol) || '0';
              totalValue = totalValue.add(new Decimal(holdingValue));
            }
          }
        }

        return {
          ...institution,
          summary: {
            accountCount,
            totalValue: totalValue.toString(),
          },
        };
      });

      return institutionsWithSummary;
    }), // Create new institution
    create: protectedProcedure
      .input(CreateInstitutionSchema.omit({ userId: true }))
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        const institution = await institutionService.createInstitution(
          {
            ...input,
            typeId: input.type, // Input has 'type' code, service expects 'typeId' which it resolves
            userId: userId,
            // biome-ignore lint/suspicious/noExplicitAny: Type mismatch between router input and service expected input during type resolution
          } as any,
          userId
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'institution',
          operationType: 'create',
          entityId: institution.id,
          userId,
          data: {
            typeId: institution.typeId,
          },
        });

        return institution;
      }),

    // Remove user's accounts from institution (institutions are global, so we don't delete the institution itself)
    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);

        // Use service to handle deletion logic
        const result = await institutionService.deleteInstitution(input.id, userId);

        if (!result) {
          throw new Error('Failed to delete institution or no accounts found');
        }

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'institution',
          operationType: 'delete',
          entityId: input.id,
          userId,
          data: {},
        });

        return {
          success: true,
        };
      }),

    // Get Open Graph metadata from a website URL
    getOpenGraphMetadata: protectedProcedure
      .input(z.object({ url: z.string().url() }))
      .query(async ({ input }) => {
        try {
          const { result } = await ogs({ url: input.url });

          return {
            title: result.ogTitle || result.twitterTitle || result.dcTitle || '',
            description:
              result.ogDescription || result.twitterDescription || result.dcDescription || '',
            siteName: result.ogSiteName || '',
            image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url || '',
            type: result.ogType || '',
          };
        } catch (error) {
          console.error('Failed to fetch Open Graph metadata:', error);
          // Return empty metadata instead of throwing
          return {
            title: '',
            description: '',
            siteName: '',
            image: '',
            type: '',
          };
        }
      }),
  });
}

// Legacy export for backwards compatibility
// biome-ignore lint/suspicious/noExplicitAny: Temporary null export for backwards compatibility during migration
export const institutionsRouter = null as any;
