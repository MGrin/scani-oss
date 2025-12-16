import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { NewScheduleStep, ScheduleStep } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class ScheduleStepRepository extends BaseRepository<ScheduleStep, NewScheduleStep> {
  protected readonly table = schema.scheduleSteps;
  protected readonly tableName = 'schedule_steps';

  /**
   * Find all steps for a specific schedule
   */
  async findBySchedule(
    scheduleId: string,
    transaction?: DatabaseTransaction
  ): Promise<ScheduleStep[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          step: schema.scheduleSteps,
          typeCode: schema.scheduleStepTypes.code,
          typeName: schema.scheduleStepTypes.name,
        })
        .from(schema.scheduleSteps)
        .innerJoin(
          schema.scheduleStepTypes,
          eq(schema.scheduleSteps.typeId, schema.scheduleStepTypes.id)
        )
        .where(eq(schema.scheduleSteps.scheduleId, scheduleId))
        .orderBy(schema.scheduleSteps.stepOrder);

      return results.map((result) => ({
        ...result.step,
        typeCode: result.typeCode,
        typeName: result.typeName,
      })) as ScheduleStep[];
    } catch (error) {
      this.logger.error({ scheduleId, error }, 'Failed to find schedule steps by schedule');
      throw error;
    }
  }

  /**
   * Delete all steps for a specific schedule
   */
  async deleteBySchedule(scheduleId: string, transaction?: DatabaseTransaction): Promise<number> {
    try {
      const database = this.getDb(transaction);
      const result = await database
        .delete(schema.scheduleSteps)
        .where(eq(schema.scheduleSteps.scheduleId, scheduleId))
        .returning();

      return result.length;
    } catch (error) {
      this.logger.error({ scheduleId, error }, 'Failed to delete schedule steps');
      throw error;
    }
  }

  /**
   * Find a step by ID and schedule ID
   */
  async findByIdAndSchedule(
    id: string,
    scheduleId: string,
    transaction?: DatabaseTransaction
  ): Promise<ScheduleStep | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          step: schema.scheduleSteps,
          typeCode: schema.scheduleStepTypes.code,
          typeName: schema.scheduleStepTypes.name,
        })
        .from(schema.scheduleSteps)
        .innerJoin(
          schema.scheduleStepTypes,
          eq(schema.scheduleSteps.typeId, schema.scheduleStepTypes.id)
        )
        .where(
          and(eq(schema.scheduleSteps.id, id), eq(schema.scheduleSteps.scheduleId, scheduleId))
        )
        .limit(1);

      if (results.length === 0) {
        return null;
      }

      const result = results[0];
      if (!result) {
        return null;
      }

      return {
        ...result.step,
        typeCode: result.typeCode,
        typeName: result.typeName,
      } as ScheduleStep;
    } catch (error) {
      this.logger.error({ id, scheduleId, error }, 'Failed to find schedule step');
      throw error;
    }
  }
}
