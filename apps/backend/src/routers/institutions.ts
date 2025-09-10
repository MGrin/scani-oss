import { CreateInstitutionSchema, UpdateInstitutionSchema } from '@scani/shared/types';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

// Helper function to check if institution name already exists
async function checkInstitutionNameExists(name: string, userId: string, excludeId?: string) {
  const whereConditions = [
    sql`LOWER(${schema.institutions.name}) = LOWER(${name})`,
    eq(schema.institutions.userId, userId),
    eq(schema.institutions.isActive, true),
  ];

  if (excludeId) {
    whereConditions.push(sql`${schema.institutions.id} != ${excludeId}`);
  }

  const existing = await routerDb
    .select({ id: schema.institutions.id })
    .from(schema.institutions)
    .where(and(...whereConditions))
    .limit(1);

  return existing.length > 0;
}

// Helper function to check if institution has linked accounts
async function checkInstitutionHasAccounts(institutionId: string) {
  const linkedAccounts = await routerDb
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(eq(schema.accounts.institutionId, institutionId), eq(schema.accounts.isActive, true))
    )
    .limit(1);

  return linkedAccounts.length > 0;
}

export const institutionsRouter = router({
  // Get all institutions
  getAll: publicProcedure.query(async () => {
    const institutions = await routerDb
      .select({
        id: schema.institutions.id,
        userId: schema.institutions.userId,
        name: schema.institutions.name,
        typeId: schema.institutions.typeId,
        type: schema.institutionTypes.code, // Include type code for backward compatibility
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

  // Get institutions by user ID
  getByUserId: publicProcedure.input(z.object({ userId: z.string() })).query(async ({ input }) => {
    const institutions = await routerDb
      .select({
        id: schema.institutions.id,
        userId: schema.institutions.userId,
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
      .leftJoin(schema.institutionTypes, eq(schema.institutions.typeId, schema.institutionTypes.id))
      .where(eq(schema.institutions.userId, input.userId))
      .orderBy(schema.institutions.name);
    return institutions;
  }),

  // Get institutions by type
  getByType: publicProcedure
    .input(z.object({ typeId: z.string(), userId: z.string().optional() }))
    .query(async ({ input }) => {
      const institutions = await routerDb
        .select({
          id: schema.institutions.id,
          userId: schema.institutions.userId,
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
        .where(eq(schema.institutions.typeId, input.typeId))
        .orderBy(schema.institutions.name);

      if (input.userId) {
        return institutions.filter((i) => i.userId === input.userId);
      }
      return institutions;
    }),

  // Get institution by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [institution] = await routerDb
      .select({
        id: schema.institutions.id,
        userId: schema.institutions.userId,
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
      .leftJoin(schema.institutionTypes, eq(schema.institutions.typeId, schema.institutionTypes.id))
      .where(eq(schema.institutions.id, input.id))
      .limit(1);

    if (!institution) {
      throw new Error('Institution not found');
    }
    return institution;
  }),

  // Check if institution name is unique for a user
  checkNameUniqueness: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1),
        userId: z.string().optional(),
        excludeId: z.string().optional(), // For edit mode
      })
    )
    .query(async ({ input }) => {
      // TODO: Replace with actual user ID from authentication
      const userId = input.userId || 'test-user-1';
      const exists = await checkInstitutionNameExists(input.name, userId, input.excludeId);
      return { isUnique: !exists };
    }),

  // Create new institution
  create: publicProcedure
    .input(
      CreateInstitutionSchema.omit({ userId: true }).extend({
        userId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const now = new Date();
      // TODO: Replace with actual user ID from authentication
      const userId = input.userId || 'test-user-1';

      // Check if institution name already exists for this user
      const nameExists = await checkInstitutionNameExists(input.name, userId);
      if (nameExists) {
        throw new Error(
          'An institution with this name already exists. Please choose a different name.'
        );
      }

      // Look up the institution type ID from the type code
      const [institutionType] = await routerDb
        .select({ id: schema.institutionTypes.id })
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.code, input.type))
        .limit(1);

      if (!institutionType) {
        throw new Error(`Invalid institution type: ${input.type}`);
      }

      const institutionData = {
        userId,
        id: nanoid(),
        name: input.name,
        typeId: institutionType.id, // Use typeId instead of type
        description: input.description,
        website: input.website,
        logoUrl: input.logoUrl,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };

      const [insertedInstitution] = await routerDb
        .insert(schema.institutions)
        .values(institutionData)
        .returning();

      if (!insertedInstitution) {
        throw new Error('Failed to create institution');
      }

      // Return enriched data with type information
      const [institution] = await routerDb
        .select({
          id: schema.institutions.id,
          userId: schema.institutions.userId,
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

  // Update institution
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateInstitutionSchema,
      })
    )
    .mutation(async ({ input }) => {
      // Get the current institution to check user ownership and validate name uniqueness
      const [currentInstitution] = await routerDb
        .select()
        .from(schema.institutions)
        .where(eq(schema.institutions.id, input.id))
        .limit(1);

      if (!currentInstitution) {
        throw new Error('Institution not found');
      }

      // If name is being updated, check for uniqueness
      if (input.data.name && input.data.name !== currentInstitution.name) {
        const nameExists = await checkInstitutionNameExists(
          input.data.name,
          currentInstitution.userId,
          input.id
        );
        if (nameExists) {
          throw new Error(
            'An institution with this name already exists. Please choose a different name.'
          );
        }
      }

      // Prepare update data, handling type -> typeId conversion if needed
      const updateData: Record<string, unknown> = {
        ...input.data,
        updatedAt: new Date(),
      };

      // If type is being updated, convert it to typeId
      if (input.data.type) {
        const [institutionType] = await routerDb
          .select({ id: schema.institutionTypes.id })
          .from(schema.institutionTypes)
          .where(eq(schema.institutionTypes.code, input.data.type))
          .limit(1);

        if (!institutionType) {
          throw new Error(`Invalid institution type: ${input.data.type}`);
        }

        updateData.typeId = institutionType.id;
        delete updateData.type; // Remove the type field
      }

      const [updatedInstitution] = await routerDb
        .update(schema.institutions)
        .set(updateData)
        .where(eq(schema.institutions.id, input.id))
        .returning();

      if (!updatedInstitution) {
        throw new Error('Institution not found');
      }

      // Return enriched data with type information
      const [institution] = await routerDb
        .select({
          id: schema.institutions.id,
          userId: schema.institutions.userId,
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
        .where(eq(schema.institutions.id, input.id))
        .limit(1);

      if (!institution) {
        throw new Error('Failed to retrieve updated institution');
      }

      return institution;
    }),

  // Delete institution (soft delete by setting isActive to false)
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Check if institution exists
    const [institution] = await routerDb
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.id, input.id))
      .limit(1);

    if (!institution) {
      throw new Error('Institution not found');
    }

    // Check if institution has active accounts
    const hasAccounts = await checkInstitutionHasAccounts(input.id);
    if (hasAccounts) {
      throw new Error(
        'Cannot delete institution with linked accounts. Please reassign or delete these accounts first.'
      );
    }

    const [deletedInstitution] = await routerDb
      .update(schema.institutions)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.institutions.id, input.id))
      .returning();

    if (!deletedInstitution) {
      throw new Error('Institution not found');
    }

    return { success: true, deleted: deletedInstitution };
  }),
});
