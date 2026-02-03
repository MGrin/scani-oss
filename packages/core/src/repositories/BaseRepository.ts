import { eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable, PgTransaction, TableConfig } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Service } from 'typedi';
import { getDb as getDbConnection } from '../database/connection';
import { createComponentLogger } from '../utils/logger';

export type DatabaseTransaction =
  // biome-ignore lint/suspicious/noExplicitAny: Transaction type must be flexible to accept any schema
  PgTransaction<any, any, any> | PostgresJsDatabase<any>;

/**
 * Base Repository Implementation
 *
 * Provides common CRUD operations for all repositories.
 * All concrete repositories should extend this class.
 */
@Service()
export abstract class BaseRepository<TEntity, TNewEntity = Partial<TEntity>> {
  protected readonly logger;
  protected abstract readonly table: PgTable<TableConfig> & {
    // biome-ignore lint/suspicious/noExplicitAny: Generic table type must allow any column configuration
    id: PgColumn<any>;
  };
  protected abstract readonly tableName: string;

  constructor() {
    this.logger = createComponentLogger(`repository:${this.constructor.name}`);
  }

  /**
   * Get the database instance (with or without transaction)
   * Uses a function call to ensure db is resolved at runtime rather than import time
   */
  protected getDb(transaction?: DatabaseTransaction) {
    const db = getDbConnection();
    return transaction || db;
  }

  /**
   * Find an entity by its ID
   */
  async findById(id: string, transaction?: DatabaseTransaction): Promise<TEntity | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(this.table)
        .where(eq(this.table.id, id))
        .limit(1);

      return (results[0] as TEntity) || null;
    } catch (error) {
      this.logger.error(
        { id, error: error instanceof Error ? error.message : error },
        `Failed to find ${this.tableName} by ID`
      );
      throw error;
    }
  }

  /**
   * Find multiple entities by their IDs
   */
  async findByIds(ids: string[], transaction?: DatabaseTransaction): Promise<TEntity[]> {
    if (ids.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      const results = await database.select().from(this.table).where(inArray(this.table.id, ids));

      return results as TEntity[];
    } catch (error) {
      this.logger.error(
        { ids, error: error instanceof Error ? error.message : error },
        `Failed to find ${this.tableName} by IDs`
      );
      throw error;
    }
  }

  /**
   * Find all entities with optional filtering
   */
  async findAll(
    filters?: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<TEntity[]> {
    try {
      const database = this.getDb(transaction);
      let query = database.select().from(this.table);

      if (filters) {
        const conditions = this.buildWhereConditions(filters);
        if (conditions.length > 0) {
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle ORM query builder type incompatibility
          query = query.where(sql.join(conditions, sql` AND `)) as any;
        }
      }

      const results = await query;
      return results as TEntity[];
    } catch (error) {
      this.logger.error(
        { filters, error: error instanceof Error ? error.message : error },
        `Failed to find all ${this.tableName}`
      );
      throw error;
    }
  }

  /**
   * Find entities with pagination
   */
  async findWithPagination(
    page: number,
    limit: number,
    filters?: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<{ data: TEntity[]; total: number; page: number; limit: number }> {
    try {
      const database = this.getDb(transaction);
      const offset = (page - 1) * limit;

      let dataQuery = database.select().from(this.table);
      let countQuery = database.select({ count: sql<number>`count(*)` }).from(this.table);

      if (filters) {
        const conditions = this.buildWhereConditions(filters);
        if (conditions.length > 0) {
          const whereClause = sql.join(conditions, sql` AND `);
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle ORM query builder type incompatibility
          dataQuery = dataQuery.where(whereClause) as any;
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle ORM query builder type incompatibility
          countQuery = countQuery.where(whereClause) as any;
        }
      }

      const [data, countResult] = await Promise.all([
        dataQuery.limit(limit).offset(offset),
        countQuery,
      ]);

      const total = Number(countResult[0]?.count || 0);

      return {
        data: data as TEntity[],
        total,
        page,
        limit,
      };
    } catch (error) {
      this.logger.error(
        {
          page,
          limit,
          filters,
          error: error instanceof Error ? error.message : error,
        },
        `Failed to find ${this.tableName} with pagination`
      );
      throw error;
    }
  }

  /**
   * Create a new entity
   */
  async create(data: TNewEntity, transaction?: DatabaseTransaction): Promise<TEntity> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .insert(this.table)
        // biome-ignore lint/suspicious/noExplicitAny: Generic type constraint for Drizzle ORM insert
        .values(data as any)
        .returning();

      if (!results[0]) {
        throw new Error(`Failed to create ${this.tableName}`);
      }

      this.logger.debug(
        // biome-ignore lint/suspicious/noExplicitAny: Dynamic entity type with id property
        { id: (results[0] as any).id },
        `Created ${this.tableName}`
      );
      return results[0] as TEntity;
    } catch (error) {
      this.logger.error(
        { data, error: error instanceof Error ? error.message : error },
        `Failed to create ${this.tableName}`
      );
      throw error;
    }
  }

  /**
   * Create multiple entities
   */
  async createMany(data: TNewEntity[], transaction?: DatabaseTransaction): Promise<TEntity[]> {
    try {
      if (data.length === 0) return [];

      const database = this.getDb(transaction);
      const results = await database
        .insert(this.table)
        // biome-ignore lint/suspicious/noExplicitAny: Generic array type constraint for Drizzle ORM batch insert
        .values(data as any[])
        .returning();

      this.logger.debug({ count: results.length }, `Created multiple ${this.tableName}`);
      return results as TEntity[];
    } catch (error) {
      this.logger.error(
        {
          count: data.length,
          error: error instanceof Error ? error.message : error,
        },
        `Failed to create multiple ${this.tableName}`
      );
      throw error;
    }
  }

  /**
   * Update an entity by ID
   */
  async update(
    id: string,
    data: Partial<TEntity>,
    transaction?: DatabaseTransaction
  ): Promise<TEntity | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .update(this.table)
        // biome-ignore lint/suspicious/noExplicitAny: Generic type constraint for Drizzle ORM update
        .set(data as any)
        .where(eq(this.table.id, id))
        .returning();

      if (!results[0]) {
        return null;
      }

      this.logger.debug({ id }, `Updated ${this.tableName}`);
      return results[0] as TEntity;
    } catch (error) {
      this.logger.error(
        { id, data, error: error instanceof Error ? error.message : error },
        `Failed to update ${this.tableName}`
      );
      throw error;
    }
  }

  /**
   * Delete an entity by ID (hard delete)
   */
  async delete(id: string, transaction?: DatabaseTransaction): Promise<boolean> {
    try {
      const database = this.getDb(transaction);
      const results = await database.delete(this.table).where(eq(this.table.id, id)).returning();

      const deleted = results.length > 0;
      if (deleted) {
        this.logger.debug({ id }, `Deleted ${this.tableName}`);
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        { id, error: error instanceof Error ? error.message : error },
        `Failed to delete ${this.tableName}`
      );
      throw error;
    }
  }

  /**
   * Check if an entity exists
   */
  async exists(id: string, transaction?: DatabaseTransaction): Promise<boolean> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({ id: this.table.id })
        .from(this.table)
        .where(eq(this.table.id, id))
        .limit(1);

      return results.length > 0;
    } catch (error) {
      this.logger.error(
        { id, error: error instanceof Error ? error.message : error },
        `Failed to check if ${this.tableName} exists`
      );
      throw error;
    }
  }

  /**
   * Count entities with optional filtering
   */
  async count(
    filters?: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    try {
      const database = this.getDb(transaction);
      let query = database.select({ count: sql<number>`count(*)` }).from(this.table);

      if (filters) {
        const conditions = this.buildWhereConditions(filters);
        if (conditions.length > 0) {
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle ORM query builder type incompatibility
          query = query.where(sql.join(conditions, sql` AND `)) as any;
        }
      }

      const results = await query;
      return Number(results[0]?.count || 0);
    } catch (error) {
      this.logger.error(
        { filters, error: error instanceof Error ? error.message : error },
        `Failed to count ${this.tableName}`
      );
      throw error;
    }
  }

  /**
   * Build WHERE conditions from filter object
   */
  protected buildWhereConditions(filters: Record<string, unknown>): SQL[] {
    const conditions: SQL[] = [];

    for (const [key, value] of Object.entries(filters)) {
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic table column access
      if (value !== undefined && value !== null && (this.table as any)[key]) {
        // biome-ignore lint/suspicious/noExplicitAny: Dynamic table column access
        conditions.push(eq((this.table as any)[key], value));
      }
    }

    return conditions;
  }
}
