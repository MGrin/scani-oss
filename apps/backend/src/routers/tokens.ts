import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { protectedProcedure, router } from "../trpc";

// Local schemas for token operations (will be moved to shared later)
const CreateTokenSchema = z.object({
  symbol: z.string().min(1).max(10),
  name: z.string().min(1).max(100),
  typeId: z.string().uuid(), // Reference to token_types table
  decimals: z.number().int().min(0).max(18).default(2),
  iconUrl: z.string().url().optional(),
  isActive: z.boolean().default(true),
});

const UpdateTokenSchema = CreateTokenSchema.partial();

export const tokensRouter = router({
  // Get all active tokens with their types
  getAll: protectedProcedure.query(async () => {
    const tokens = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        typeId: schema.tokens.typeId,
        type: schema.tokenTypes.code,
        typeName: schema.tokenTypes.name,
        decimals: schema.tokens.decimals,
        iconUrl: schema.tokens.iconUrl,
        isActive: schema.tokens.isActive,
        createdAt: schema.tokens.createdAt,
        updatedAt: schema.tokens.updatedAt,
      })
      .from(schema.tokens)
      .leftJoin(
        schema.tokenTypes,
        eq(schema.tokens.typeId, schema.tokenTypes.id)
      )
      .where(eq(schema.tokens.isActive, true))
      .orderBy(schema.tokens.symbol);
    return tokens;
  }),

  // Get fiat currencies (tokens with type 'fiat')
  getCurrencies: protectedProcedure.query(async () => {
    const currencies = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        decimals: schema.tokens.decimals,
        iconUrl: schema.tokens.iconUrl,
      })
      .from(schema.tokens)
      .leftJoin(
        schema.tokenTypes,
        eq(schema.tokens.typeId, schema.tokenTypes.id)
      )
      .where(
        and(
          eq(schema.tokens.isActive, true),
          eq(schema.tokenTypes.code, "fiat")
        )
      )
      .orderBy(schema.tokens.symbol);
    return currencies;
  }),

  // Get tokens by type code
  getByTypeCode: protectedProcedure
    .input(z.object({ typeCode: z.string() }))
    .query(async ({ input }) => {
      const tokens = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeId: schema.tokens.typeId,
          type: schema.tokenTypes.code,
          typeName: schema.tokenTypes.name,
          decimals: schema.tokens.decimals,
          iconUrl: schema.tokens.iconUrl,
          isActive: schema.tokens.isActive,
          createdAt: schema.tokens.createdAt,
          updatedAt: schema.tokens.updatedAt,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(
          and(
            eq(schema.tokenTypes.code, input.typeCode),
            eq(schema.tokens.isActive, true)
          )
        )
        .orderBy(schema.tokens.symbol);
      return tokens;
    }),

  // Get token by ID
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [token] = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeId: schema.tokens.typeId,
          type: schema.tokenTypes.code,
          typeName: schema.tokenTypes.name,
          decimals: schema.tokens.decimals,
          iconUrl: schema.tokens.iconUrl,
          isActive: schema.tokens.isActive,
          createdAt: schema.tokens.createdAt,
          updatedAt: schema.tokens.updatedAt,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(eq(schema.tokens.id, input.id))
        .limit(1);

      if (!token) {
        throw new Error("Token not found");
      }
      return token;
    }),

  // Get token by symbol
  getBySymbol: protectedProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const [token] = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeId: schema.tokens.typeId,
          type: schema.tokenTypes.code,
          typeName: schema.tokenTypes.name,
          decimals: schema.tokens.decimals,
          iconUrl: schema.tokens.iconUrl,
          isActive: schema.tokens.isActive,
          createdAt: schema.tokens.createdAt,
          updatedAt: schema.tokens.updatedAt,
        })
        .from(schema.tokens)
        .leftJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id)
        )
        .where(eq(schema.tokens.symbol, input.symbol.toUpperCase()))
        .limit(1);

      if (!token) {
        throw new Error("Token not found");
      }
      return token;
    }),

  // Create new token
  create: protectedProcedure
    .input(CreateTokenSchema)
    .mutation(async ({ input }) => {
      // Check if symbol already exists
      const [existingToken] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, input.symbol.toUpperCase()))
        .limit(1);

      if (existingToken) {
        throw new Error("Token with this symbol already exists");
      }

      const now = new Date();
      const tokenData = {
        ...input,
        symbol: input.symbol.toUpperCase(), // Ensure symbols are uppercase
        createdAt: now,
        updatedAt: now,
      };

      const [createdToken] = await db
        .insert(schema.tokens)
        .values(tokenData)
        .returning();

      if (!createdToken) {
        throw new Error("Failed to create token");
      }

      return createdToken;
    }),

  // Update token
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateTokenSchema,
      })
    )
    .mutation(async ({ input }) => {
      // If updating symbol, check for uniqueness
      if (input.data.symbol) {
        const [existingToken] = await db
          .select()
          .from(schema.tokens)
          .where(
            and(
              eq(schema.tokens.symbol, input.data.symbol.toUpperCase()),
              // Exclude current token from uniqueness check
              sql`${schema.tokens.id} != ${input.id}`
            )
          )
          .limit(1);

        if (existingToken) {
          throw new Error("Token with this symbol already exists");
        }
      }

      const updateData = {
        ...input.data,
        ...(input.data.symbol && { symbol: input.data.symbol.toUpperCase() }),
        updatedAt: new Date(),
      };

      const [updatedToken] = await db
        .update(schema.tokens)
        .set(updateData)
        .where(eq(schema.tokens.id, input.id))
        .returning();

      if (!updatedToken) {
        throw new Error("Token not found");
      }

      return updatedToken;
    }),

  // Delete token (soft delete by setting isActive to false)
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const [deletedToken] = await db
        .update(schema.tokens)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.tokens.id, input.id))
        .returning();

      if (!deletedToken) {
        throw new Error("Token not found");
      }

      return { success: true, deleted: deletedToken };
    }),
});
