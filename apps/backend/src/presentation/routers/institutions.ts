import Decimal from 'decimal.js';
import ogs from 'open-graph-scraper';
import Container from 'typedi';
import { z } from 'zod';
import { PortfolioValuationService } from '../../application/services/PortfolioValuationService';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { protectedProcedure, router } from '../trpc';

const institutionRepository = Container.get(InstitutionRepository);
const accountRepository = Container.get(AccountRepository);
const holdingRepository = Container.get(HoldingRepository);
const portfolioService = Container.get(PortfolioValuationService);
const tokenRepository = Container.get(TokenRepository);

export const institutionsRouter = router({
  // Get all institutions
  // KEEP
  getAll: protectedProcedure.query(async () => {
    const institutions = await institutionRepository.findAll();
    return institutions;
  }),

  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const institutions = await institutionRepository.findByUserId(userId);
    return institutions;
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = ctx;
    const userId = dbUser.id;

    // Get user's institutions
    const institutions = await institutionRepository.findByUserId(userId);

    if (institutions.length === 0) {
      return [];
    }

    const accounts = await accountRepository.findByUser(userId);

    // Get all holdings for this user
    const holdings = await holdingRepository.findByUser(userId);

    // Get portfolio valuation for value calculations
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
  }),

  // KEEP
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const institution = await institutionRepository.findById(input.id);
    return institution ?? null;
  }),

  // Get Open Graph metadata from a website URL
  // KEEP
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
