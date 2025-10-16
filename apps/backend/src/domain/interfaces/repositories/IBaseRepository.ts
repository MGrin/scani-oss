import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Base Repository Interface
 *
 * Provides common CRUD operations for all repositories.
 * All repositories should extend this interface.
 */

export interface IBaseRepository<TEntity, TNewEntity = Partial<TEntity>> {
  /**
   * Find an entity by its ID
   */
  findById(id: string, transaction?: DatabaseTransaction): Promise<TEntity | null>;

  /**
   * Find all entities with optional filtering
   */
  findAll(filters?: Record<string, unknown>, transaction?: DatabaseTransaction): Promise<TEntity[]>;

  /**
   * Find entities with pagination
   */
  findWithPagination(
    page: number,
    limit: number,
    filters?: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<{ data: TEntity[]; total: number; page: number; limit: number }>;

  /**
   * Create a new entity
   */
  create(data: TNewEntity, transaction?: DatabaseTransaction): Promise<TEntity>;

  /**
   * Create multiple entities
   */
  createMany(data: TNewEntity[], transaction?: DatabaseTransaction): Promise<TEntity[]>;

  /**
   * Update an entity by ID
   */
  update(
    id: string,
    data: Partial<TEntity>,
    transaction?: DatabaseTransaction
  ): Promise<TEntity | null>;

  /**
   * Delete an entity by ID (hard delete)
   */
  delete(id: string, transaction?: DatabaseTransaction): Promise<boolean>;

  /**
   * Soft delete an entity (if applicable)
   */
  softDelete?(id: string, transaction?: DatabaseTransaction): Promise<boolean>;

  /**
   * Check if an entity exists
   */
  exists(id: string, transaction?: DatabaseTransaction): Promise<boolean>;

  /**
   * Count entities with optional filtering
   */
  count(filters?: Record<string, unknown>, transaction?: DatabaseTransaction): Promise<number>;
}

/**
 * Database transaction type for repository operations
 * Using unknown to represent schema types safely while maintaining type compatibility
 */
// biome-ignore lint/suspicious/noExplicitAny: Transaction type must be flexible to accept any schema
export type DatabaseTransaction = PgTransaction<any, any, any> | PostgresJsDatabase<any>;
