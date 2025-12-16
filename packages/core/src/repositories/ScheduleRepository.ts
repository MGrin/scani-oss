import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { NewSchedule, Schedule } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class ScheduleRepository extends BaseRepository<Schedule, NewSchedule> {
  protected readonly table = schema.schedules;
  protected readonly tableName = 'schedules';

  /**
   * Find all schedules for a specific user
   */
  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Schedule[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          schedule: schema.schedules,
          typeCode: schema.scheduleTypes.code,
          typeName: schema.scheduleTypes.name,
        })
        .from(schema.schedules)
        .innerJoin(schema.scheduleTypes, eq(schema.schedules.typeId, schema.scheduleTypes.id))
        .where(and(eq(schema.schedules.userId, userId), eq(schema.schedules.isActive, true)))
        .orderBy(schema.schedules.name);

      return results.map((result) => ({
        ...result.schedule,
        typeCode: result.typeCode,
        typeName: result.typeName,
      })) as Schedule[];
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find schedules by user');
      throw error;
    }
  }

  /**
   * Find a schedule by ID for a specific user
   */
  async findByIdAndUser(
    id: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Schedule | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          schedule: schema.schedules,
          typeCode: schema.scheduleTypes.code,
          typeName: schema.scheduleTypes.name,
        })
        .from(schema.schedules)
        .innerJoin(schema.scheduleTypes, eq(schema.schedules.typeId, schema.scheduleTypes.id))
        .where(and(eq(schema.schedules.id, id), eq(schema.schedules.userId, userId)))
        .limit(1);

      if (results.length === 0) {
        return null;
      }

      const result = results[0];
      if (!result) {
        return null;
      }

      return {
        ...result.schedule,
        typeCode: result.typeCode,
        typeName: result.typeName,
      } as Schedule;
    } catch (error) {
      this.logger.error({ id, userId, error }, 'Failed to find schedule by ID and user');
      throw error;
    }
  }

  /**
   * Soft delete a schedule (set isActive to false)
   */
  async softDelete(
    id: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    try {
      const database = this.getDb(transaction);
      const result = await database
        .update(schema.schedules)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(schema.schedules.id, id), eq(schema.schedules.userId, userId)))
        .returning();

      return result.length > 0;
    } catch (error) {
      this.logger.error({ id, userId, error }, 'Failed to soft delete schedule');
      throw error;
    }
  }
}
