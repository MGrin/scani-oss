import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Entity, NewEntity } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * Ownership boundaries — the two sets of books a contractor with a limited
 * company keeps (SC-463).
 *
 * There is no membership resolution here and that is the point. An account
 * carries one `entity_id` or none, so "which entity is this holding in" is a
 * column read through `holdings.account_id`, which is `NOT NULL`. Compare
 * `GroupRepository.resolveMembership`, which exists because a group is a
 * standing rule with a veto and three states; an ownership boundary has one
 * state and cannot afford the other two.
 */
@Service()
export class EntityRepository extends BaseRepository<Entity, NewEntity> {
  protected readonly table = schema.entities;
  protected readonly tableName = 'entities';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Entity[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.userId, userId))
        .orderBy(schema.entities.name);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find entities by user');
      throw error;
    }
  }

  /**
   * Every account this user has, and which entity it sits in.
   *
   * Returned for ALL accounts rather than only assigned ones, because the
   * unassigned bucket is a real bucket that has to be rendered: an account
   * missing from this map would be silently absent from every total instead of
   * visibly outside the boundaries.
   */
  async findAccountEntityMap(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, string | null>> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({ id: schema.accounts.id, entityId: schema.accounts.entityId })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, userId));
      return new Map(rows.map((row) => [row.id, row.entityId]));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to map accounts to entities');
      throw error;
    }
  }
}
