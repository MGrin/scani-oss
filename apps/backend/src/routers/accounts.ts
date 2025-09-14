import { UpdateAccountSchema } from '@scani/shared/types';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

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

  // Get accounts by institution ID
  getByInstitutionId: protectedProcedure
    .input(z.object({ institutionId: z.string() }))
    .query(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const accounts = await db
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
        .where(
          and(
            eq(schema.accounts.institutionId, input.institutionId),
            eq(schema.accounts.isActive, true),
            eq(schema.accounts.userId, userId)
          )
        )
        .orderBy(schema.accounts.name);
      return accounts;
    }),

  // Get accounts by type
  getByType: protectedProcedure
    .input(z.object({ type: z.string(), institutionId: z.string().optional() }))
    .query(async ({ input }) => {
      const whereConditions = [
        eq(schema.accountTypes.code, input.type),
        eq(schema.accounts.isActive, true),
      ];

      if (input.institutionId) {
        whereConditions.push(eq(schema.accounts.institutionId, input.institutionId));
      }

      const accounts = await db
        .select()
        .from(schema.accounts)
        .leftJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
        .where(and(...whereConditions))
        .orderBy(schema.accounts.name);
      return accounts;
    }),

  // Get account by ID
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [account] = await db
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
  checkNameUniqueness: protectedProcedure
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

  // Update account
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateAccountSchema,
      })
    )
    .mutation(async ({ input }) => {
      // Get the current account to check institution and validate name uniqueness
      const [currentAccount] = await db
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
        description: input.data.description?.trim() || null,
        updatedAt: new Date(),
      };

      const [updatedAccount] = await db
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
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Check if account exists
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.id))
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
