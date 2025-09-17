import { CreateInstitutionSchema } from '@scani/shared/types';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// Helper function to check if institution name already exists
async function checkInstitutionNameExists(name: string, excludeId?: string) {
  // Use safe parameter binding - Drizzle will handle proper escaping
  const whereConditions = [
    sql`LOWER(${schema.institutions.name}) = ${name.toLowerCase()}`,
    eq(schema.institutions.isActive, true),
  ];

  if (excludeId) {
    whereConditions.push(ne(schema.institutions.id, excludeId));
  }

  const existing = await db
    .select({ id: schema.institutions.id })
    .from(schema.institutions)
    .where(and(...whereConditions))
    .limit(1);

  return existing.length > 0;
}

export const institutionsRouter = router({
  // Get all institutions
  getAll: protectedProcedure.query(async () => {
    const institutions = await db
      .select({
        id: schema.institutions.id,
        name: schema.institutions.name,
        typeId: schema.institutions.typeId,
        type: schema.institutionTypes.code, // Include type code for backward compatibility
        typeName: schema.institutionTypes.name,
        description: schema.institutions.description,
        website: schema.institutions.website,
        logoUrl: schema.institutions.logoUrl,
        isActive: schema.institutions.isActive,
        createdAt: schema.institutions.createdAt,
        updatedAt: schema.institutions.updatedAt,
      })
      .from(schema.institutions)
      .leftJoin(schema.institutionTypes, eq(schema.institutions.typeId, schema.institutionTypes.id))
      .where(eq(schema.institutions.isActive, true))
      .orderBy(schema.institutions.name);
    return institutions;
  }),

  // Get institutions where the current user has accounts
  getByUserId: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    const institutions = await db
      .selectDistinct({
        id: schema.institutions.id,
        name: schema.institutions.name,
        typeId: schema.institutions.typeId,
        type: schema.institutionTypes.code,
        typeName: schema.institutionTypes.name,
        description: schema.institutions.description,
        website: schema.institutions.website,
        logoUrl: schema.institutions.logoUrl,
        isActive: schema.institutions.isActive,
        createdAt: schema.institutions.createdAt,
        updatedAt: schema.institutions.updatedAt,
      })
      .from(schema.institutions)
      .innerJoin(schema.accounts, eq(schema.accounts.institutionId, schema.institutions.id))
      .leftJoin(schema.institutionTypes, eq(schema.institutions.typeId, schema.institutionTypes.id))
      .where(
        and(
          eq(schema.institutions.isActive, true),
          eq(schema.accounts.isActive, true),
          eq(schema.accounts.userId, userId)
        )
      )
      .orderBy(schema.institutions.name);
    return institutions;
  }),

  // Create new institution
  create: protectedProcedure
    .input(CreateInstitutionSchema.omit({ userId: true }))
    .mutation(async ({ input }) => {
      const now = new Date();

      // Check if institution name already exists
      const nameExists = await checkInstitutionNameExists(input.name);
      if (nameExists) {
        throw new Error(
          'An institution with this name already exists. Please choose a different name.'
        );
      }

      // Look up the institution type ID from the type code
      const [institutionType] = await db
        .select({ id: schema.institutionTypes.id })
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.code, input.type))
        .limit(1);

      if (!institutionType) {
        throw new Error(`Invalid institution type: ${input.type}`);
      }

      const institutionData = {
        name: input.name,
        typeId: institutionType.id, // Use typeId instead of type
        description: input.description,
        website: input.website,
        logoUrl: input.logoUrl,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };

      const [insertedInstitution] = await db
        .insert(schema.institutions)
        .values(institutionData)
        .returning();

      if (!insertedInstitution) {
        throw new Error('Failed to create institution');
      }

      // Return enriched data with type information
      const [institution] = await db
        .select({
          id: schema.institutions.id,
          name: schema.institutions.name,
          typeId: schema.institutions.typeId,
          type: schema.institutionTypes.code,
          description: schema.institutions.description,
          website: schema.institutions.website,
          logoUrl: schema.institutions.logoUrl,
          isActive: schema.institutions.isActive,
          createdAt: schema.institutions.createdAt,
          updatedAt: schema.institutions.updatedAt,
        })
        .from(schema.institutions)
        .leftJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .where(eq(schema.institutions.id, insertedInstitution.id))
        .limit(1);

      if (!institution) {
        throw new Error('Failed to retrieve created institution');
      }

      return institution;
    }),

  // Remove user's accounts from institution (institutions are global, so we don't delete the institution itself)
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // First verify the institution exists
      const [institution] = await db
        .select()
        .from(schema.institutions)
        .where(eq(schema.institutions.id, input.id))
        .limit(1);

      if (!institution) {
        throw new Error('Institution not found');
      }

      // Get user's accounts for this institution (for logging purposes before deletion)
      const userAccounts = await db
        .select({ id: schema.accounts.id, name: schema.accounts.name })
        .from(schema.accounts)
        .where(
          and(eq(schema.accounts.institutionId, input.id), eq(schema.accounts.userId, userId))
        );

      if (userAccounts.length === 0) {
        throw new Error('No accounts found for this institution');
      }

      // Get holdings and transactions counts for cascade info
      const userHoldings = await db
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .where(
          and(eq(schema.accounts.institutionId, input.id), eq(schema.accounts.userId, userId))
        );

      const userTransactions = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .where(
          and(eq(schema.accounts.institutionId, input.id), eq(schema.accounts.userId, userId))
        );

      // Delete user's accounts for this institution - cascading deletes will handle holdings and transactions
      const deletedAccounts = await db
        .delete(schema.accounts)
        .where(and(eq(schema.accounts.institutionId, input.id), eq(schema.accounts.userId, userId)))
        .returning();

      return {
        success: true,
        deleted: institution, // Return institution info for UI consistency
        cascadeInfo: {
          accountsDeleted: deletedAccounts.length,
          holdingsDeleted: userHoldings.length,
          transactionsDeleted: userTransactions.length,
        },
      };
    }),
});
