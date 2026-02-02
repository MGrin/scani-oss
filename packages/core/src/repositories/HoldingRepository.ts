import { and, eq, lt, ne } from "drizzle-orm";
import { Service } from "typedi";
import { SCAM_PROBABILITY_THRESHOLD } from "../config/tokens";
import * as schema from "../database/schema";
import type { Holding, NewHolding, Token } from "../domain/entities";
import { BaseRepository, type DatabaseTransaction } from "./BaseRepository";

/**
 * Type for holdings with full details including token, account, and institution info
 */
export interface HoldingWithFullDetails {
  holding: Holding;
  token: Token & { typeCode: string; typeName: string };
  account: {
    id: string;
    name: string;
    institutionId: string;
    typeCode: string;
    typeName: string;
  };
  institution: {
    id: string;
    name: string;
    typeCode: string;
    typeName: string;
    website: string | null;
  };
}

@Service()
export class HoldingRepository extends BaseRepository<Holding, NewHolding> {
  protected readonly table = schema.holdings;
  protected readonly tableName = "holdings";

  async findByUser(
    userId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
  ): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const conditions = [
        eq(schema.holdings.userId, userId),
        lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
      ];
      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }
      const whereConditions = and(...conditions);

      const results = await database
        .select({
          holding: schema.holdings,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(whereConditions)
        .orderBy(schema.holdings.lastUpdated);

      // Return only the holding objects (scam tokens already filtered at database level)
      return results.map((r) => r.holding);
    } catch (error) {
      this.logger.error({ userId, error }, "Failed to find holdings by user");
      throw error;
    }
  }

  async findByAccountAndToken(
    accountId: string,
    tokenId: string,
    userId: string,
    excludeId?: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);

      const conditions = [
        eq(schema.holdings.accountId, accountId),
        eq(schema.holdings.tokenId, tokenId),
        eq(schema.holdings.userId, userId),
      ];

      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }

      if (excludeId) {
        conditions.push(ne(schema.holdings.id, excludeId));
      }

      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(...conditions))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { accountId, tokenId, userId, excludeId, error },
        "Failed to find holding by account and token",
      );
      throw error;
    }
  }

  /**
   * Find holdings by user with complete details including token, account, and institution information.
   * This is a convenience wrapper around findByUserWithFullDetails without accountId filter.
   *
   * @deprecated Use findByUserWithFullDetails instead
   */
  async findByUserWithCompleteDetails(
    userId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
  ): Promise<
    Array<{
      holding: Holding;
      token: Token & { typeCode: string; typeName: string };
      account: {
        id: string;
        name: string;
        institutionId: string;
        typeCode: string;
        typeName: string;
      };
      institution: {
        id: string;
        name: string;
        website?: string;
        typeCode: string;
        typeName: string;
      };
    }>
  > {
    // Delegate to findByUserWithFullDetails without accountId filter
    const results = await this.findByUserWithFullDetails(
      userId,
      undefined,
      transaction,
      includeHidden,
    );

    // Transform website field from string | null to string | undefined for backward compatibility
    return results.map((r) => ({
      ...r,
      institution: {
        ...r.institution,
        website: r.institution.website ?? undefined,
      },
    }));
  }

  async findByUserWithFullDetails(
    userId: string,
    accountId?: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
  ): Promise<HoldingWithFullDetails[]> {
    try {
      const database = this.getDb(transaction);

      // Build where conditions
      const conditions = [eq(schema.holdings.userId, userId)];
      if (accountId) {
        conditions.push(eq(schema.holdings.accountId, accountId));
      }
      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }
      // Filter out scam tokens (only for crypto tokens)
      conditions.push(
        lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
      );
      const whereConditions = and(...conditions);

      const results = await database
        .select({
          // Holdings data
          holdingId: schema.holdings.id,
          holdingUserId: schema.holdings.userId,
          holdingAccountId: schema.holdings.accountId,
          holdingTokenId: schema.holdings.tokenId,
          holdingBalance: schema.holdings.balance,
          holdingSource: schema.holdings.source,
          holdingIsHidden: schema.holdings.isHidden,
          holdingIsActive: schema.holdings.isActive,
          holdingLastUpdated: schema.holdings.lastUpdated,
          holdingCreatedAt: schema.holdings.createdAt,
          // Token data with type
          token: schema.tokens,
          tokenTypeCode: schema.tokenTypes.code,
          tokenTypeName: schema.tokenTypes.name,
          // Account data with type
          accountId: schema.accounts.id,
          accountName: schema.accounts.name,
          accountInstitutionId: schema.accounts.institutionId,
          accountTypeCode: schema.accountTypes.code,
          accountTypeName: schema.accountTypes.name,
          // Institution data with type
          institutionId: schema.institutions.id,
          institutionName: schema.institutions.name,
          institutionWebsite: schema.institutions.website,
          institutionTypeCode: schema.institutionTypes.code,
          institutionTypeName: schema.institutionTypes.name,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(
          schema.tokenTypes,
          eq(schema.tokens.typeId, schema.tokenTypes.id),
        )
        .innerJoin(
          schema.accounts,
          eq(schema.holdings.accountId, schema.accounts.id),
        )
        .innerJoin(
          schema.accountTypes,
          eq(schema.accounts.typeId, schema.accountTypes.id),
        )
        .innerJoin(
          schema.institutions,
          eq(schema.accounts.institutionId, schema.institutions.id),
        )
        .innerJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id),
        )
        .where(whereConditions);

      return results.map((r) => ({
        holding: {
          id: r.holdingId,
          userId: r.holdingUserId,
          accountId: r.holdingAccountId,
          tokenId: r.holdingTokenId,
          balance: r.holdingBalance,
          source: r.holdingSource,
          isHidden: r.holdingIsHidden,
          isActive: r.holdingIsActive,
          lastUpdated: r.holdingLastUpdated,
          createdAt: r.holdingCreatedAt,
        },
        token: {
          ...r.token,
          typeCode: r.tokenTypeCode,
          typeName: r.tokenTypeName,
        },
        account: {
          id: r.accountId,
          name: r.accountName,
          institutionId: r.accountInstitutionId,
          typeCode: r.accountTypeCode,
          typeName: r.accountTypeName,
        },
        institution: {
          id: r.institutionId,
          name: r.institutionName,
          typeCode: r.institutionTypeCode,
          typeName: r.institutionTypeName,
          website: r.institutionWebsite,
        },
      }));
    } catch (error) {
      this.logger.error(
        { userId, accountId, error },
        "Failed to find holdings with full details",
      );
      throw error;
    }
  }

  /**
   * Find all holdings for a specific account
   * @param accountId - The account ID to find holdings for
   * @param transaction - Optional database transaction
   * @param includeHidden - Whether to include hidden holdings (default: false)
   * @param includeScamTokens - Whether to include tokens marked as potential scams (default: false)
   */
  async findByAccount(
    accountId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
    includeScamTokens = false,
  ): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const conditions = [eq(schema.holdings.accountId, accountId)];
      if (!includeScamTokens) {
        conditions.push(
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
        );
      }
      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }
      const whereConditions = and(...conditions);

      const results = await database
        .select({
          holding: schema.holdings,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(whereConditions);

      // Return only the holding objects (scam tokens already filtered at database level)
      return results.map((r) => r.holding);
    } catch (error) {
      this.logger.error(
        { accountId, error },
        "Failed to find holdings by account",
      );
      throw error;
    }
  }

  /**
   * Mark a holding as hidden (soft delete for blockchain holdings)
   */
  async markAsHidden(
    holdingId: string,
    transaction?: DatabaseTransaction,
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.holdings)
        .set({
          isHidden: true,
        })
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error(
        { holdingId, error },
        "Failed to mark holding as hidden",
      );
      throw error;
    }
  }

  /**
   * Unhide a holding (restore from hidden state)
   */
  async unhideHolding(
    holdingId: string,
    transaction?: DatabaseTransaction,
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.holdings)
        .set({
          isHidden: false,
        })
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error({ holdingId, error }, "Failed to unhide holding");
      throw error;
    }
  }

  /**
   * Get a holding by ID with option to include hidden
   */
  async findById(
    holdingId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);
      const conditions = includeHidden
        ? eq(schema.holdings.id, holdingId)
        : and(
            eq(schema.holdings.id, holdingId),
            eq(schema.holdings.isHidden, false),
          );

      const results = await database
        .select()
        .from(schema.holdings)
        .where(conditions)
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ holdingId, error }, "Failed to find holding by ID");
      throw error;
    }
  }

  /**
   * Update holding balance
   */
  async updateBalance(
    holdingId: string,
    balance: string,
    transaction?: DatabaseTransaction,
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.holdings)
        .set({
          balance,
          lastUpdated: new Date(),
        })
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error(
        { holdingId, balance, error },
        "Failed to update holding balance",
      );
      throw error;
    }
  }

  /**
   * Delete a holding by ID
   */
  async deleteById(
    holdingId: string,
    transaction?: DatabaseTransaction,
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .delete(schema.holdings)
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error({ holdingId, error }, "Failed to delete holding");
      throw error;
    }
  }

  /**
   * Get distinct token IDs from all holdings
   */
  async getDistinctTokenIds(
    transaction?: DatabaseTransaction,
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .selectDistinct({ tokenId: schema.holdings.tokenId })
        .from(schema.holdings);

      return results.map((row) => row.tokenId);
    } catch (error) {
      this.logger.error({ error }, "Failed to get distinct token IDs");
      throw error;
    }
  }
}
