import { ScheduleService } from '@scani/core/services';
import {
  CreateScheduleDto,
  CreateScheduleStepDto,
  IdInputDto,
  UpdateScheduleDto,
  UpdateScheduleStepDto,
} from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const scheduleService = Container.get(ScheduleService);

export const schedulesRouter = router({
  /**
   * Get all schedules for the authenticated user
   */
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await scheduleService.getSchedulesByUserId(dbUser.id);
  }),

  /**
   * Get a schedule by ID
   */
  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await scheduleService.getScheduleById(dbUser.id, input.id);
  }),

  /**
   * Get all steps for a schedule
   */
  getSteps: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await scheduleService.getScheduleSteps(dbUser.id, input.id);
  }),

  /**
   * Create a new schedule
   */
  create: protectedProcedure.input(CreateScheduleDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await scheduleService.createSchedule(input, dbUser.id);

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'schedule',
      operationType: 'create',
      entityId: result.id,
      userId: dbUser.id,
      data: result,
    });

    return result;
  }),

  /**
   * Update a schedule
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateScheduleDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await scheduleService.updateSchedule(input.id, input.data, dbUser.id);

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'schedule',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
        data: result,
      });

      return result;
    }),

  /**
   * Delete a schedule
   */
  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await scheduleService.deleteSchedule(input.id, dbUser.id);

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'schedule',
      operationType: 'delete',
      entityId: input.id,
      userId: dbUser.id,
      data: {},
    });

    return { success: result };
  }),

  /**
   * Create a schedule step
   */
  createStep: protectedProcedure.input(CreateScheduleStepDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await scheduleService.createScheduleStep(input, dbUser.id);

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'schedule_step',
      operationType: 'create',
      entityId: result.id,
      userId: dbUser.id,
      data: result,
    });

    return result;
  }),

  /**
   * Update a schedule step
   */
  updateStep: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        scheduleId: z.string().uuid(),
        data: UpdateScheduleStepDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await scheduleService.updateScheduleStep(
        input.id,
        input.data,
        dbUser.id,
        input.scheduleId
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'schedule_step',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
        data: result,
      });

      return result;
    }),

  /**
   * Delete a schedule step
   */
  deleteStep: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        scheduleId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await scheduleService.deleteScheduleStep(
        input.id,
        dbUser.id,
        input.scheduleId
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'schedule_step',
        operationType: 'delete',
        entityId: input.id,
        userId: dbUser.id,
        data: {},
      });

      return { success: result };
    }),
});
