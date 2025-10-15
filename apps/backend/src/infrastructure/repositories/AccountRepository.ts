import { and, eq, ne, sql } from "drizzle-orm";
import { Service } from "typedi";
import type { Account, Holding, NewAccount } from "../../domain/entities";
import type {
  DatabaseTransaction,
  IAccountRepository,
} from "../../domain/interfaces/repositories";
import * as schema from "../database/schema";
import { BaseRepository } from "./BaseRepository";

@Service()
export class AccountRepository
  extends BaseRepository<Account, NewAccount>
  implements IAccountRepository
{
  protected readonly table = schema.accounts;
  protected readonly tableName = "accounts";

  async findByUser(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Account[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          account: schema.accounts,
          type: schema.accountTypes.code,
          typeName: schema.accountTypes.name,
        })
        .from(schema.accounts)
        .innerJoin(
          schema.accountTypes,
          eq(schema.accounts.typeId, schema.accountTypes.id)
        )
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true)
          )
        )
        .orderBy(schema.accounts.name);

      return results.map((result) => ({
        ...result.account,
        type: result.type,
        typeName: result.typeName,
      }));
    } catch (error) {
      this.logger.error({ userId, error }, "Failed to find accounts by user");
      throw error;
    }
  }

  async findByInstitution(
    institutionId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Account[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          account: schema.accounts,
          type: schema.accountTypes.code,
          typeName: schema.accountTypes.name,
        })
        .from(schema.accounts)
        .innerJoin(
          schema.accountTypes,
          eq(schema.accounts.typeId, schema.accountTypes.id)
        )
        .where(
          and(
            eq(schema.accounts.institutionId, institutionId),
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true)
          )
        )
        .orderBy(schema.accounts.name);

      return results.map((result) => ({
        ...result.account,
        type: result.type,
        typeName: result.typeName,
      }));
    } catch (error) {
      this.logger.error(
        { institutionId, userId, error },
        "Failed to find accounts by institution"
      );
      throw error;
    }
  }

  async findWithHoldings(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Account & { holdings: Holding[] }) | null> {
    try {
      const database = this.getDb(transaction);

      // Get account
      const [account] = await database
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.id, accountId),
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true)
          )
        )
        .limit(1);

      if (!account) return null;

      // Get holdings for this account
      const holdings = await database
        .select()
        .from(schema.holdings)
        .where(
          and(
            eq(schema.holdings.accountId, accountId),
            eq(schema.holdings.userId, userId)
          )
        );

      return {
        ...account,
        holdings,
      };
    } catch (error) {
      this.logger.error(
        { accountId, userId, error },
        "Failed to find account with holdings"
      );
      throw error;
    }
  }

  async findByNameAndInstitution(
    name: string,
    institutionId: string,
    userId: string,
    excludeId?: string,
    transaction?: DatabaseTransaction
  ): Promise<Account | null> {
    try {
      const database = this.getDb(transaction);

      const conditions = [
        sql`LOWER(${schema.accounts.name}) = ${name.toLowerCase()}`,
        eq(schema.accounts.institutionId, institutionId),
        eq(schema.accounts.userId, userId),
        eq(schema.accounts.isActive, true),
      ];

      if (excludeId) {
        conditions.push(ne(schema.accounts.id, excludeId));
      }

      const results = await database
        .select()
        .from(schema.accounts)
        .where(and(...conditions))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { name, institutionId, userId, excludeId, error },
        "Failed to find account by name and institution"
      );
      throw error;
    }
  }

  async findWithDetails(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    | (Account & { institutionName: string; type: string; typeName: string })
    | null
  > {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          account: schema.accounts,
          institutionName: schema.institutions.name,
          type: schema.accountTypes.code,
          typeName: schema.accountTypes.name,
        })
        .from(schema.accounts)
        .innerJoin(
          schema.institutions,
          eq(schema.accounts.institutionId, schema.institutions.id)
        )
        .innerJoin(
          schema.accountTypes,
          eq(schema.accounts.typeId, schema.accountTypes.id)
        )
        .where(
          and(
            eq(schema.accounts.id, accountId),
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true)
          )
        )
        .limit(1);

      if (!results[0]) return null;

      return {
        ...results[0].account,
        institutionName: results[0].institutionName,
        type: results[0].type,
        typeName: results[0].typeName,
      };
    } catch (error) {
      this.logger.error(
        { accountId, userId, error },
        "Failed to find account with details"
      );
      throw error;
    }
  }

  async findByInstitutionAndMetadata(
    institutionId: string,
    metadata: string,
    transaction?: DatabaseTransaction
  ): Promise<Account | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.institutionId, institutionId),
            eq(schema.accounts.metadata, metadata),
            eq(schema.accounts.isActive, true)
          )
        )
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { institutionId, metadata, error },
        "Failed to find account by institution and metadata"
      );
      throw error;
    }
  }
}
