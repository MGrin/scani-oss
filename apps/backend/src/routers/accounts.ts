import { AccountType, CreateAccountSchema, UpdateAccountSchema } from '@scani/shared/types';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

// Helper function to check if account name already exists within an institution
async function checkAccountNameExists(name: string, institutionId: string, excludeId?: string) {
  const whereConditions = [
    sql`LOWER(${schema.accounts.name}) = LOWER(${name})`,
    eq(schema.accounts.institutionId, institutionId),
    eq(schema.accounts.isActive, true),
  ];

  if (excludeId) {
    whereConditions.push(sql`${schema.accounts.id} != ${excludeId}`);
  }

  const existing = await routerDb
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(...whereConditions))
    .limit(1);

  return existing.length > 0;
}

export const accountsRouter = router({
  // Get all accounts
  getAll: publicProcedure.query(async () => {
    const accounts = await routerDb
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.isActive, true))
      .orderBy(schema.accounts.name);
    return accounts;
  }),

  // Get accounts by institution ID
  getByInstitutionId: publicProcedure
    .input(z.object({ institutionId: z.string() }))
    .query(async ({ input }) => {
      const accounts = await routerDb
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.institutionId, input.institutionId),
            eq(schema.accounts.isActive, true)
          )
        )
        .orderBy(schema.accounts.name);
      return accounts;
    }),

  // Get accounts by type
  getByType: publicProcedure
    .input(z.object({ type: AccountType, institutionId: z.string().optional() }))
    .query(async ({ input }) => {
      let whereCondition = and(
        eq(schema.accounts.type, input.type),
        eq(schema.accounts.isActive, true)
      );

      if (input.institutionId) {
        whereCondition = and(
          whereCondition,
          eq(schema.accounts.institutionId, input.institutionId)
        );
      }

      const accounts = await routerDb
        .select()
        .from(schema.accounts)
        .where(whereCondition)
        .orderBy(schema.accounts.name);
      return accounts;
    }),

  // Get account by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [account] = await routerDb
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.id))
      .limit(1);

    if (!account) {
      throw new Error('Account not found');
    }
    return account;
  }),

  // Check if account name is unique within an institution
  checkNameUniqueness: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1),
        institutionId: z.string(),
        excludeId: z.string().optional(), // For edit mode
      })
    )
    .query(async ({ input }) => {
      const exists = await checkAccountNameExists(input.name, input.institutionId, input.excludeId);
      return { isUnique: !exists };
    }),

  // Create new account
  create: publicProcedure.input(CreateAccountSchema).mutation(async ({ input }) => {
    // Check if account name already exists within this institution
    const nameExists = await checkAccountNameExists(input.name, input.institutionId);
    if (nameExists) {
      throw new Error(
        'An account with this name already exists in this institution. Please choose a different name.'
      );
    }

    const now = new Date();
    const accountData = {
      ...input,
      name: input.name.trim(), // Ensure trimmed
      description: input.description?.trim() || undefined,
      accountNumber: input.accountNumber?.trim() || undefined,
      id: nanoid(),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const [account] = await routerDb.insert(schema.accounts).values(accountData).returning();

    return account;
  }),

  // Update account
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateAccountSchema,
      })
    )
    .mutation(async ({ input }) => {
      // Get the current account to check institution and validate name uniqueness
      const [currentAccount] = await routerDb
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.id))
        .limit(1);

      if (!currentAccount) {
        throw new Error('Account not found');
      }

      // If name is being updated, check for uniqueness within the institution
      if (input.data.name && input.data.name !== currentAccount.name) {
        const nameExists = await checkAccountNameExists(
          input.data.name,
          currentAccount.institutionId,
          input.id
        );
        if (nameExists) {
          throw new Error(
            'An account with this name already exists in this institution. Please choose a different name.'
          );
        }
      }

      const updateData = {
        ...input.data,
        name: input.data.name?.trim(),
        description: input.data.description?.trim() || undefined,
        accountNumber: input.data.accountNumber?.trim() || undefined,
        updatedAt: new Date(),
      };

      const [updatedAccount] = await routerDb
        .update(schema.accounts)
        .set(updateData)
        .where(eq(schema.accounts.id, input.id))
        .returning();

      if (!updatedAccount) {
        throw new Error('Account not found');
      }

      return updatedAccount;
    }),

  // Delete account (hard delete with cascade to holdings and transactions)
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Check if account exists
    const [account] = await routerDb
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.id))
      .limit(1);

    if (!account) {
      throw new Error('Account not found');
    }

    // Get holdings count for logging purposes (before deletion)
    const holdings = await routerDb
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.accountId, input.id));

    // Get transactions count (via holdings) for logging purposes (before deletion)
    const transactions = await routerDb
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
      .where(eq(schema.holdings.accountId, input.id));

    // Hard delete the account - this will cascade to holdings and transactions
    // due to the foreign key constraints with onDelete: 'cascade'
    const [deletedAccount] = await routerDb
      .delete(schema.accounts)
      .where(eq(schema.accounts.id, input.id))
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
});
