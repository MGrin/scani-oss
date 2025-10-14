import Decimal from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import type { AccountService } from '../../application/services/AccountService';
import { PortfolioValuationService } from '../../application/services/PortfolioValuationService';
import { PricingService } from '../../application/services/PricingService';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import type { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { getUserId } from '../../middleware/auth';
import { createComponentLogger } from '../../utils/logger';
import { protectedProcedure, router } from '../trpc';

const accountsLogger = createComponentLogger('router:accounts');

/**
 * Factory function to create the accounts router with injected dependencies
 */
export function createAccountsRouter(
  _accountRepository: AccountRepository,
  accountService: AccountService
) {
  return router({
    // Get all accounts
    getAll: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);
      const accounts = await accountService.getAccountsByUserId(userId);
      return accounts;
    }),

    // Get accounts with summary data (holdings count, total value)
    getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);

      // Get user's accounts
      const accounts = await accountService.getAccountsByUserId(userId);

      if (accounts.length === 0) {
        return [];
      }

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

      // Create value map from portfolio data (token symbol -> total value for that token)
      const valueMap = new Map(portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || '0']));

      // Get token repository to map holding tokenIds to symbols
      const { TokenRepository } = await import('../../infrastructure/repositories/TokenRepository');
      const tokenRepository = Container.get(TokenRepository);
      const tokenIds = [...new Set(holdings.map((h) => h.tokenId))];
      const tokens = await tokenRepository.findByIds(tokenIds);
      const tokenMap = new Map(tokens.map((t) => [t.id, t]));

      // Build summary for each account
      const accountsWithSummary = accounts.map((account) => {
        const accountHoldings = holdingsByAccount.get(account.id) || [];
        const holdingsCount = accountHoldings.length;

        // Calculate total value across all holdings in this account
        let totalValue = new Decimal(0);
        for (const holding of accountHoldings) {
          const token = tokenMap.get(holding.tokenId);
          if (token) {
            const holdingValue = valueMap.get(token.symbol) || '0';
            totalValue = totalValue.add(new Decimal(holdingValue));
          }
        }

        return {
          ...account,
          summary: {
            holdingsCount,
            totalValue: totalValue.toString(),
          },
        };
      });

      return accountsWithSummary;
    }),

    getById: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        const account = await accountService.getAccountById(input.id, userId);
        return account ?? null;
      }),

    // Create new account
    create: protectedProcedure
      .input(
        z.object({
          institutionId: z.string().min(1, 'Institution ID cannot be empty'),
          name: z
            .string()
            .min(1, 'Account name cannot be empty')
            .max(100, 'Account name must be 100 characters or less'),
          type: z.string().min(1, 'Account type cannot be empty'),
          description: z.string().max(500, 'Description must be 500 characters or less').optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);

        accountsLogger.debug(
          {
            userId,
            institutionId: input.institutionId,
            accountType: input.type,
          },
          'Creating account'
        );

        const account = await accountService.createAccount(
          {
            institutionId: input.institutionId,
            name: input.name.trim(),
            typeCode: input.type, // Service will resolve type code to typeId
            description: input.description?.trim(),
          },
          userId
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'account',
          operationType: 'create',
          entityId: account.id,
          userId,
          data: {
            institutionId: account.institutionId,
            typeId: account.typeId,
          },
        });

        return account;
      }),

    // Delete account (hard delete with cascade to holdings and transactions)
    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
        const result = await accountService.deleteAccount(input.id, userId);

        if (!result) {
          throw new Error('Account not found or could not be deleted');
        }

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'account',
          operationType: 'delete',
          entityId: input.id,
          userId,
          data: {},
        });

        return {
          success: true,
        };
      }),

    // Get account summaries with total balances (in base currency)
    getSummaries: protectedProcedure.query(async ({ ctx }) => {
      const userId = getUserId(ctx);

      try {
        // Use portfolio valuation service to get properly converted values
        const portfolioValuationService = Container.get(PortfolioValuationService);
        const portfolioValue = await portfolioValuationService.getUserPortfolioValue(userId);

        // Get all user accounts with their institutions and account types
        const accounts = await db
          .select({
            id: schema.accounts.id,
            name: schema.accounts.name,
            type: schema.accountTypes.code,
            typeName: schema.accountTypes.name,
            institutionId: schema.accounts.institutionId,
            institutionName: schema.institutions.name,
          })
          .from(schema.accounts)
          .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
          .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
          .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.isActive, true)));

        // Get user holdings with account information to calculate account balances
        const userHoldings = await db
          .select({
            id: schema.holdings.id,
            accountId: schema.holdings.accountId,
            balance: schema.holdings.balance,
            tokenSymbol: schema.tokens.symbol,
            tokenId: schema.holdings.tokenId,
          })
          .from(schema.holdings)
          .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
          .where(eq(schema.holdings.userId, userId));

        // Get user's base currency for direct price calculations
        const [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        if (!user?.baseCurrencyId) {
          throw new Error('User has no base currency set');
        }

        const [baseCurrency] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, user.baseCurrencyId))
          .limit(1);

        if (!baseCurrency) {
          throw new Error('Base currency token not found');
        }

        // Get current token prices for all unique tokens using batch processing
        const uniqueTokens = [...new Set(userHoldings.map((h) => h.tokenSymbol))];
        const priceResults: Record<string, string> = {};

        // Use singleton pricing service

        // Use batch price fetching for better performance
        const tokensToPrice = uniqueTokens.filter((symbol) => symbol !== baseCurrency.symbol);

        if (tokensToPrice.length > 0) {
          try {
            // Get full token objects for pricing service
            const tokens = await db
              .select()
              .from(schema.tokens)
              .where(inArray(schema.tokens.symbol, tokensToPrice));

            // biome-ignore lint/suspicious/noExplicitAny: PricingService type issue with Container.get
            const pricingService = Container.get(PricingService) as any;
            const batchPrices = await pricingService.getTokenPrices(
              tokens,
              baseCurrency.symbol,
              new Date()
            );

            // Map batch results to our price results using token symbol as key
            for (const token of tokens) {
              const price = batchPrices.get(token.id);
              if (price) {
                priceResults[token.symbol] = price;
              }
            }
          } catch (error) {
            accountsLogger.warn(
              {
                userId,
                tokenCount: tokensToPrice.length,
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'Batch price fetch failed, falling back to individual calls'
            );

            // Fallback to individual calls if batch fails
            for (const tokenSymbol of tokensToPrice) {
              try {
                // Get the token object first
                const token = await db
                  .select()
                  .from(schema.tokens)
                  .where(eq(schema.tokens.symbol, tokenSymbol))
                  .limit(1);

                if (token[0]) {
                  const pricingServiceInstance = Container.get(
                    PricingService
                    // biome-ignore lint/suspicious/noExplicitAny: PricingService type issue with Container.get
                  ) as any;
                  const price = await pricingServiceInstance.getTokenPrice(
                    token[0],
                    baseCurrency.symbol,
                    new Date()
                  );
                  priceResults[tokenSymbol] = price;
                }
              } catch (priceError) {
                accountsLogger.warn(
                  {
                    userId,
                    symbol: tokenSymbol,
                    error:
                      priceError instanceof Error
                        ? { name: priceError.name, message: priceError.message }
                        : priceError,
                  },
                  'Failed to fetch token price for account summary'
                );
              }
            }
          }
        }

        // Base currency price is always 1
        priceResults[baseCurrency.symbol] = '1';

        // Calculate account balances by summing individual holding values
        const accountSummaries = accounts.map((account) => {
          const accountHoldings = userHoldings.filter((h) => h.accountId === account.id);

          // Sum up the base currency values for this account
          const totalBalance = accountHoldings.reduce((sum, holding) => {
            const balance = parseFloat(holding.balance || '0');
            const price = parseFloat(priceResults[holding.tokenSymbol] || '0');
            return sum + balance * price;
          }, 0);

          return {
            id: account.id,
            name: account.name,
            type: account.type,
            typeName: account.typeName,
            institutionId: account.institutionId,
            institutionName: account.institutionName,
            totalBalance,
            holdingsCount: accountHoldings.length,
          };
        });

        // Calculate overall summaries by account type
        const typeSummaries = accountSummaries.reduce(
          (acc, account) => {
            const type = account.type;
            if (!acc[type]) {
              acc[type] = {
                type,
                typeName: account.typeName,
                accountCount: 0,
                totalBalance: 0,
              };
            }

            acc[type].accountCount += 1;
            acc[type].totalBalance += account.totalBalance;

            return acc;
          },
          {} as Record<
            string,
            {
              type: string;
              typeName: string;
              accountCount: number;
              totalBalance: number;
            }
          >
        );

        return {
          accounts: accountSummaries,
          typesSummary: Object.values(typeSummaries),
          totalBalance: portfolioValue.totalValue, // Use portfolio service total
          totalAccounts: accountSummaries.length,
        };
      } catch (error) {
        accountsLogger.warn(
          {
            userId,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Failed to get portfolio value for account summaries'
        );

        // Fallback to raw balance calculation if portfolio service fails
        const accounts = await db
          .select({
            id: schema.accounts.id,
            name: schema.accounts.name,
            type: schema.accountTypes.code,
            typeName: schema.accountTypes.name,
            institutionId: schema.accounts.institutionId,
            institutionName: schema.institutions.name,
          })
          .from(schema.accounts)
          .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
          .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
          .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.isActive, true)));

        const holdings = await db
          .select({
            id: schema.holdings.id,
            accountId: schema.holdings.accountId,
            balance: schema.holdings.balance,
            tokenId: schema.holdings.tokenId,
          })
          .from(schema.holdings)
          .where(eq(schema.holdings.userId, userId));

        const accountSummaries = accounts.map((account) => {
          const accountHoldings = holdings.filter((h) => h.accountId === account.id);
          const totalBalance = accountHoldings.reduce((sum, holding) => {
            return sum + parseFloat(holding.balance || '0');
          }, 0);

          return {
            id: account.id,
            name: account.name,
            type: account.type,
            typeName: account.typeName,
            institutionId: account.institutionId,
            institutionName: account.institutionName,
            totalBalance,
            holdingsCount: accountHoldings.length,
          };
        });

        const typeSummaries = accountSummaries.reduce(
          (acc, account) => {
            const type = account.type;
            if (!acc[type]) {
              acc[type] = {
                type,
                typeName: account.typeName,
                accountCount: 0,
                totalBalance: 0,
              };
            }

            acc[type].accountCount += 1;
            acc[type].totalBalance += account.totalBalance;

            return acc;
          },
          {} as Record<
            string,
            {
              type: string;
              typeName: string;
              accountCount: number;
              totalBalance: number;
            }
          >
        );

        return {
          accounts: accountSummaries,
          typesSummary: Object.values(typeSummaries),
          totalBalance: accountSummaries.reduce((sum, acc) => sum + acc.totalBalance, 0),
          totalAccounts: accountSummaries.length,
        };
      }
    }),
    // Note: getSummaries endpoint kept as-is for now - contains complex pricing logic
    // that would require significant refactoring to move to a service
  });
}

// Legacy export for backwards compatibility
// biome-ignore lint/suspicious/noExplicitAny: Temporary null export for backwards compatibility during migration
export const accountsRouter = null as any;
