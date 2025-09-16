import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { PortfolioValuationService } from '../services/portfolio-valuation';
import { protectedProcedure, router } from '../trpc';

// Helper function to check if account name already exists within an institution
async function checkAccountNameExists(name: string, institutionId: string, excludeId?: string) {
  // Use safe parameter binding - Drizzle will handle proper escaping
  const whereConditions = [
    sql`LOWER(${schema.accounts.name}) = ${name.toLowerCase()}`,
    eq(schema.accounts.institutionId, institutionId),
    eq(schema.accounts.isActive, true),
  ];

  if (excludeId) {
    whereConditions.push(ne(schema.accounts.id, excludeId));
  }

  const existing = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(...whereConditions))
    .limit(1);

  return existing.length > 0;
}

export const accountsRouter = router({
  // Get all accounts
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    return await db
      .select({
        id: schema.accounts.id,
        institutionId: schema.accounts.institutionId,
        name: schema.accounts.name,
        typeId: schema.accounts.typeId,
        type: schema.accountTypes.code,
        typeName: schema.accountTypes.name,
        description: schema.accounts.description,
        isActive: schema.accounts.isActive,
        createdAt: schema.accounts.createdAt,
        updatedAt: schema.accounts.updatedAt,
      })
      .from(schema.accounts)
      .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
      .leftJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .where(and(eq(schema.accounts.isActive, true), eq(schema.accounts.userId, userId)));
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
        type: z.string().min(1, 'Account type cannot be empty'), // This will be the type code
        description: z.string().max(500, 'Description must be 500 characters or less').optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // Check if account name already exists within this institution
      const nameExists = await checkAccountNameExists(input.name, input.institutionId);
      if (nameExists) {
        throw new Error(
          'An account with this name already exists in this institution. Please choose a different name.'
        );
      }

      // Look up the account type by code to get the typeId
      const [accountType] = await db
        .select()
        .from(schema.accountTypes)
        .where(
          and(eq(schema.accountTypes.code, input.type), eq(schema.accountTypes.isActive, true))
        )
        .limit(1);

      if (!accountType) {
        throw new Error(`Invalid account type: ${input.type}`);
      }

      // Validate that the institution exists and is active
      const [institution] = await db
        .select({ id: schema.institutions.id })
        .from(schema.institutions)
        .where(
          and(
            eq(schema.institutions.id, input.institutionId),
            eq(schema.institutions.isActive, true)
          )
        )
        .limit(1);

      if (!institution) {
        throw new Error(`Invalid or inactive institution: ${input.institutionId}`);
      }

      const now = new Date();
      const accountData = {
        userId,
        institutionId: input.institutionId,
        name: input.name.trim(),
        typeId: accountType.id, // Use the actual typeId
        description: input.description?.trim() || null, // Use null instead of undefined
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };

      console.log('Creating account with data:', JSON.stringify(accountData, null, 2));
      console.log('Account type found:', JSON.stringify(accountType, null, 2));
      console.log('Institution found:', JSON.stringify(institution, null, 2));

      try {
        const [account] = await db.insert(schema.accounts).values(accountData).returning();

        return account;
      } catch (error) {
        console.error('Database insert error:', error);
        console.error('Account data:', accountData);

        // Check if it's a foreign key constraint error
        if (error instanceof Error && error.message.includes('foreign key')) {
          throw new Error(
            'Invalid reference: Please check that the institution and account type exist.'
          );
        }

        // Check if it's a unique constraint error
        if (error instanceof Error && error.message.includes('unique constraint')) {
          throw new Error('Account name already exists in this institution.');
        }

        throw error;
      }
    }),

  // Delete account (hard delete with cascade to holdings and transactions)
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // Check if account exists AND belongs to the user
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, input.id), eq(schema.accounts.userId, userId)))
        .limit(1);

      if (!account) {
        throw new Error('Account not found');
      }

      // Get holdings count for logging purposes (before deletion)
      const holdings = await db
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, input.id));

      // Get transactions count (via holdings) for logging purposes (before deletion)
      const transactions = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .where(eq(schema.holdings.accountId, input.id));

      // Hard delete the account - this will cascade to holdings and transactions
      // due to the foreign key constraints with onDelete: 'cascade'
      const [deletedAccount] = await db
        .delete(schema.accounts)
        .where(and(eq(schema.accounts.id, input.id), eq(schema.accounts.userId, userId)))
        .returning();

      if (!deletedAccount) {
        throw new Error('Account not found');
      }

      return {
        success: true,
        deleted: deletedAccount,
        cascadeInfo: {
          holdingsDeleted: holdings.length,
          transactionsDeleted: transactions.length,
        },
      };
    }),

  // Get account summaries with total balances (in base currency)
  getSummaries: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    try {
      // Use portfolio valuation service to get properly converted values
      const portfolioService = new PortfolioValuationService();
      const portfolioValue = await portfolioService.getUserPortfolioValue(userId);

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

      // Calculate account balances using portfolio service pricing
      const accountSummaries = accounts.map((account) => {
        const accountHoldings = userHoldings.filter((h) => h.accountId === account.id);

        // Sum up the base currency values for this account
        const totalBalance = accountHoldings.reduce((sum, holding) => {
          // Find matching portfolio holding to get base currency value
          const portfolioHolding = portfolioValue.holdings.find(
            (ph) => ph.tokenSymbol === holding.tokenSymbol
          );

          if (portfolioHolding?.value) {
            // Scale the portfolio holding value based on this account's proportion of the total token balance
            const accountBalance = parseFloat(holding.balance);
            const totalTokenBalance = userHoldings
              .filter((h) => h.tokenSymbol === holding.tokenSymbol)
              .reduce((total, h) => total + parseFloat(h.balance), 0);

            if (totalTokenBalance > 0) {
              const proportion = accountBalance / totalTokenBalance;
              const totalValue = parseFloat(portfolioHolding.value);
              return sum + totalValue * proportion;
            }
          }
          return sum;
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
      console.warn('Failed to get portfolio value for account summaries:', error);

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
});
