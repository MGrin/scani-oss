import type {
  CreateScheduleInput,
  CreateScheduleStepInput,
  UpdateScheduleInput,
  UpdateScheduleStepInput,
} from '@scani/shared';
import { Container, Service } from 'typedi';
import type { Schedule, ScheduleStep } from '../domain/entities';
import type { DatabaseTransaction } from '../repositories/BaseRepository';
import {
  ScheduleStepTypeRepository,
  ScheduleTypeRepository,
} from '../repositories/EnumRepositories';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { ScheduleRepository } from '../repositories/ScheduleRepository';
import { ScheduleStepRepository } from '../repositories/ScheduleStepRepository';
import { BaseService } from './BaseService';

@Service()
export class ScheduleService extends BaseService {
  private readonly scheduleRepository = Container.get(ScheduleRepository);
  private readonly scheduleStepRepository = Container.get(ScheduleStepRepository);
  private readonly scheduleTypeRepository = Container.get(ScheduleTypeRepository);
  private readonly scheduleStepTypeRepository = Container.get(ScheduleStepTypeRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  constructor() {
    super('ScheduleService');
  }

  /**
   * Get all schedules for a user
   */
  async getSchedulesByUserId(userId: string, tx?: DatabaseTransaction): Promise<Schedule[]> {
    try {
      this.logInfo('Getting schedules by user ID', { userId });

      const schedules = await this.scheduleRepository.findByUser(userId, tx);

      this.logInfo('Retrieved schedules', { userId, count: schedules.length });
      return schedules;
    } catch (error) {
      this.logError('Failed to get schedules by user ID', { userId, error });
      throw error;
    }
  }

  /**
   * Get a schedule by ID for a specific user
   */
  async getScheduleById(
    userId: string,
    scheduleId: string,
    tx?: DatabaseTransaction
  ): Promise<Schedule | null> {
    try {
      this.logInfo('Getting schedule by ID', { userId, scheduleId });

      const schedule = await this.scheduleRepository.findByIdAndUser(scheduleId, userId, tx);

      if (!schedule) {
        this.logInfo('Schedule not found', { userId, scheduleId });
        return null;
      }

      this.logInfo('Retrieved schedule', { userId, scheduleId });
      return schedule;
    } catch (error) {
      this.logError('Failed to get schedule by ID', { userId, scheduleId, error });
      throw error;
    }
  }

  /**
   * Get all steps for a schedule
   */
  async getScheduleSteps(
    userId: string,
    scheduleId: string,
    tx?: DatabaseTransaction
  ): Promise<ScheduleStep[]> {
    try {
      this.logInfo('Getting schedule steps', { userId, scheduleId });

      // Verify schedule belongs to user
      const schedule = await this.scheduleRepository.findByIdAndUser(scheduleId, userId, tx);
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      const steps = await this.scheduleStepRepository.findBySchedule(scheduleId, tx);

      this.logInfo('Retrieved schedule steps', { userId, scheduleId, count: steps.length });
      return steps;
    } catch (error) {
      this.logError('Failed to get schedule steps', { userId, scheduleId, error });
      throw error;
    }
  }

  /**
   * Create a new schedule
   */
  async createSchedule(
    data: CreateScheduleInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Schedule> {
    try {
      this.logInfo('Creating schedule', { name: data.name, userId });

      this.validateRequiredFields(data, ['name', 'typeId']);
      this.validateNonEmptyString(data.name, 'name');

      // Validate that either cron pattern or interval is provided
      const hasCron =
        data.repetitiveCronPattern !== undefined && data.repetitiveCronPattern !== null;
      const hasInterval = data.interval !== undefined && data.interval !== null;

      if (!hasCron && !hasInterval) {
        throw new Error('Either repetitiveCronPattern or interval must be provided');
      }
      if (hasCron && hasInterval) {
        throw new Error('Cannot provide both repetitiveCronPattern and interval');
      }

      if (hasCron) {
        this.validateNonEmptyString(data.repetitiveCronPattern as string, 'repetitiveCronPattern');
      }
      if (hasInterval) {
        this.validateNonEmptyString(data.interval as string, 'interval');
      }

      // Validate schedule type exists
      const scheduleType = await this.scheduleTypeRepository.findById(data.typeId, tx);
      this.assertExists(scheduleType, `Schedule type with ID ${data.typeId} not found`);

      const schedule = await this.scheduleRepository.create(
        {
          name: data.name,
          description: data.description || null,
          repetitiveCronPattern: data.repetitiveCronPattern || null,
          interval: data.interval || null,
          intervalStartDate: data.intervalStartDate || (hasInterval ? new Date() : null),
          lastExecuted: null,
          typeId: data.typeId,
          userId,
          isActive: true,
        },
        tx
      );

      this.logInfo('Schedule created successfully', { scheduleId: schedule.id, userId });
      return schedule;
    } catch (error) {
      this.logError('Failed to create schedule', { userId, error });
      throw error;
    }
  }

  /**
   * Update a schedule
   */
  async updateSchedule(
    scheduleId: string,
    data: UpdateScheduleInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Schedule> {
    try {
      this.logInfo('Updating schedule', { scheduleId, userId });

      // Verify schedule exists and belongs to user
      const schedule = await this.scheduleRepository.findByIdAndUser(scheduleId, userId, tx);
      this.assertExists(schedule, 'Schedule not found');

      // Validate schedule type if being updated
      if (data.typeId) {
        const scheduleType = await this.scheduleTypeRepository.findById(data.typeId, tx);
        this.assertExists(scheduleType, `Schedule type with ID ${data.typeId} not found`);
      }

      const updated = await this.scheduleRepository.update(scheduleId, data, tx);
      this.assertExists(updated, 'Failed to update schedule');

      this.logInfo('Schedule updated successfully', { scheduleId, userId });
      return updated;
    } catch (error) {
      this.logError('Failed to update schedule', { scheduleId, userId, error });
      throw error;
    }
  }

  /**
   * Delete a schedule (soft delete)
   */
  async deleteSchedule(
    scheduleId: string,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<boolean> {
    try {
      this.logInfo('Deleting schedule', { scheduleId, userId });

      // Verify schedule exists and belongs to user
      const schedule = await this.scheduleRepository.findByIdAndUser(scheduleId, userId, tx);
      this.assertExists(schedule, 'Schedule not found');

      const result = await this.scheduleRepository.softDelete(scheduleId, userId, tx);

      this.logInfo('Schedule deleted successfully', { scheduleId, userId });
      return result;
    } catch (error) {
      this.logError('Failed to delete schedule', { scheduleId, userId, error });
      throw error;
    }
  }

  /**
   * Create a schedule step with validation
   */
  async createScheduleStep(
    data: CreateScheduleStepInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<ScheduleStep> {
    try {
      this.logInfo('Creating schedule step', { scheduleId: data.scheduleId, userId });

      this.validateRequiredFields(data, ['scheduleId', 'typeId', 'data']);

      // Verify schedule exists and belongs to user
      const schedule = await this.scheduleRepository.findByIdAndUser(data.scheduleId, userId, tx);
      this.assertExists(schedule, 'Schedule not found');

      // Validate step type exists
      const stepType = await this.scheduleStepTypeRepository.findById(data.typeId, tx);
      this.assertExists(stepType, `Schedule step type with ID ${data.typeId} not found`);

      // Validate step data based on type
      await this.validateScheduleStepData(stepType?.code || '', data.data, userId, tx);

      // Validate schedule type restrictions before creating the step
      await this.validateScheduleTypeRestrictions(
        schedule,
        stepType?.code || '',
        data.stepOrder || 0,
        tx
      );

      const step = await this.scheduleStepRepository.create(
        {
          scheduleId: data.scheduleId,
          typeId: data.typeId,
          data: data.data as unknown,
          stepOrder: data.stepOrder || 0,
        },
        tx
      );

      this.logInfo('Schedule step created successfully', { stepId: step.id, userId });
      return step;
    } catch (error) {
      this.logError('Failed to create schedule step', { scheduleId: data.scheduleId, error });
      throw error;
    }
  }

  /**
   * Update a schedule step
   */
  async updateScheduleStep(
    stepId: string,
    data: UpdateScheduleStepInput,
    userId: string,
    scheduleId: string,
    tx?: DatabaseTransaction
  ): Promise<ScheduleStep> {
    try {
      this.logInfo('Updating schedule step', { stepId, scheduleId, userId });

      // Verify schedule exists and belongs to user
      const schedule = await this.scheduleRepository.findByIdAndUser(scheduleId, userId, tx);
      this.assertExists(schedule, 'Schedule not found');

      // Verify step exists and belongs to schedule
      const step = await this.scheduleStepRepository.findByIdAndSchedule(stepId, scheduleId, tx);
      this.assertExists(step, 'Schedule step not found');

      // Validate step type if being updated
      let newStepTypeCode: string | undefined;
      if (data.typeId) {
        const stepType = await this.scheduleStepTypeRepository.findById(data.typeId, tx);
        this.assertExists(stepType, `Schedule step type with ID ${data.typeId} not found`);
        newStepTypeCode = stepType?.code;
      }

      // Validate step data if being updated
      if (data.data) {
        const stepType = data.typeId
          ? await this.scheduleStepTypeRepository.findById(data.typeId, tx)
          : await this.scheduleStepTypeRepository.findById(step.typeId, tx);
        await this.validateScheduleStepData(stepType?.code || '', data.data, userId, tx);
      }

      // Validate schedule type restrictions if step type or order is being changed
      if (data.typeId || data.stepOrder !== undefined) {
        // Get the effective step type code - either from the new typeId or fetch the current one
        let effectiveStepTypeCode = newStepTypeCode;
        if (!effectiveStepTypeCode) {
          const currentStepType = await this.scheduleStepTypeRepository.findById(step.typeId, tx);
          effectiveStepTypeCode = currentStepType?.code || '';
        }
        const effectiveStepOrder = data.stepOrder !== undefined ? data.stepOrder : step.stepOrder;
        await this.validateScheduleTypeRestrictionsForUpdate(
          schedule,
          effectiveStepTypeCode,
          effectiveStepOrder,
          stepId,
          tx
        );
      }

      const updated = await this.scheduleStepRepository.update(stepId, data, tx);
      this.assertExists(updated, 'Failed to update schedule step');

      this.logInfo('Schedule step updated successfully', { stepId, userId });
      return updated;
    } catch (error) {
      this.logError('Failed to update schedule step', { stepId, scheduleId, userId, error });
      throw error;
    }
  }

  /**
   * Delete a schedule step
   */
  async deleteScheduleStep(
    stepId: string,
    userId: string,
    scheduleId: string,
    tx?: DatabaseTransaction
  ): Promise<boolean> {
    try {
      this.logInfo('Deleting schedule step', { stepId, scheduleId, userId });

      // Verify schedule exists and belongs to user
      const schedule = await this.scheduleRepository.findByIdAndUser(scheduleId, userId, tx);
      this.assertExists(schedule, 'Schedule not found');

      // Verify step exists and belongs to schedule
      const step = await this.scheduleStepRepository.findByIdAndSchedule(stepId, scheduleId, tx);
      this.assertExists(step, 'Schedule step not found');

      const result = await this.scheduleStepRepository.delete(stepId, tx);

      this.logInfo('Schedule step deleted successfully', { stepId, userId });
      return result;
    } catch (error) {
      this.logError('Failed to delete schedule step', { stepId, scheduleId, userId, error });
      throw error;
    }
  }

  /**
   * Validate schedule step data based on step type
   */
  private async validateScheduleStepData(
    stepTypeCode: string,
    data: unknown,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<void> {
    const stepData = data as Record<string, unknown>;

    switch (stepTypeCode) {
      case 'inflow': {
        // Validate inflow data: from, toHoldingId, amount
        this.validateRequiredFields(stepData, ['from', 'toHoldingId', 'amount']);
        const toHoldingId = stepData.toHoldingId as string;
        const holding = await this.holdingRepository.findById(toHoldingId, tx);
        this.assertExists(holding, `Holding with ID ${toHoldingId} not found`);
        if (holding?.userId !== userId) {
          throw new Error('Holding does not belong to user');
        }
        break;
      }
      case 'outflow': {
        // Validate outflow data: fromHoldingId, to, amount
        this.validateRequiredFields(stepData, ['fromHoldingId', 'to', 'amount']);
        const fromHoldingId = stepData.fromHoldingId as string;
        const holding = await this.holdingRepository.findById(fromHoldingId, tx);
        this.assertExists(holding, `Holding with ID ${fromHoldingId} not found`);
        if (holding?.userId !== userId) {
          throw new Error('Holding does not belong to user');
        }
        break;
      }
      case 'transfer': {
        // Validate transfer data: fromHoldingId, toHoldingId, amount XOR percent
        this.validateRequiredFields(stepData, ['fromHoldingId', 'toHoldingId']);

        const hasAmount = stepData.amount !== undefined && stepData.amount !== null;
        const hasPercent = stepData.percent !== undefined && stepData.percent !== null;

        if (hasAmount === hasPercent) {
          throw new Error('Exactly one of amount or percent must be provided for transfer');
        }

        const fromHoldingId = stepData.fromHoldingId as string;
        const toHoldingId = stepData.toHoldingId as string;

        const [fromHolding, toHolding] = await Promise.all([
          this.holdingRepository.findById(fromHoldingId, tx),
          this.holdingRepository.findById(toHoldingId, tx),
        ]);

        this.assertExists(fromHolding, `Holding with ID ${fromHoldingId} not found`);
        this.assertExists(toHolding, `Holding with ID ${toHoldingId} not found`);

        if (fromHolding?.userId !== userId || toHolding?.userId !== userId) {
          throw new Error('Holdings do not belong to user');
        }

        // Validate both holdings have the same token
        if (fromHolding?.tokenId !== toHolding?.tokenId) {
          throw new Error('Transfer holdings must have the same token');
        }
        break;
      }
      case 'conversion': {
        // Validate conversion data: fromHoldingId, toHoldingId, amount XOR percent
        this.validateRequiredFields(stepData, ['fromHoldingId', 'toHoldingId']);

        const hasAmount = stepData.amount !== undefined && stepData.amount !== null;
        const hasPercent = stepData.percent !== undefined && stepData.percent !== null;

        if (hasAmount === hasPercent) {
          throw new Error('Exactly one of amount or percent must be provided for conversion');
        }

        const fromHoldingId = stepData.fromHoldingId as string;
        const toHoldingId = stepData.toHoldingId as string;

        const [fromHolding, toHolding] = await Promise.all([
          this.holdingRepository.findById(fromHoldingId, tx),
          this.holdingRepository.findById(toHoldingId, tx),
        ]);

        this.assertExists(fromHolding, `Holding with ID ${fromHoldingId} not found`);
        this.assertExists(toHolding, `Holding with ID ${toHoldingId} not found`);

        if (fromHolding?.userId !== userId || toHolding?.userId !== userId) {
          throw new Error('Holdings do not belong to user');
        }
        break;
      }
      default:
        throw new Error(`Unknown schedule step type: ${stepTypeCode}`);
    }
  }

  /**
   * Validate schedule type restrictions when creating a new step
   * - Income allocation: can only start with inflow step (step_order 0 or lowest) and have only 1 inflow total
   * - Subscription and payment: cannot have inflow steps
   * - Other: no restrictions
   */
  private async validateScheduleTypeRestrictions(
    schedule: Schedule,
    stepTypeCode: string,
    stepOrder: number,
    tx?: DatabaseTransaction
  ): Promise<void> {
    // Get schedule type to check restrictions
    const scheduleType = await this.scheduleTypeRepository.findById(schedule.typeId, tx);
    if (!scheduleType) {
      return; // If schedule type not found, skip validation
    }

    const scheduleTypeCode = scheduleType.code;

    // Get existing steps for this schedule
    const existingSteps = await this.scheduleStepRepository.findBySchedule(schedule.id, tx);

    if (scheduleTypeCode === 'income_allocation') {
      // Income allocation schedules must start with inflow and have only 1 inflow
      if (stepTypeCode === 'inflow') {
        // Check if there's already an inflow step
        // Fetch step types for existing steps to check their codes
        const stepTypeIds = existingSteps.map((step: ScheduleStep) => step.typeId);
        const existingStepTypes = await Promise.all(
          stepTypeIds.map((typeId) => this.scheduleStepTypeRepository.findById(typeId, tx))
        );
        const hasInflowStep = existingStepTypes.some((stepType) => stepType?.code === 'inflow');

        if (hasInflowStep) {
          throw new Error('Income allocation schedules can have only one inflow step');
        }

        // Check if this is the first step (lowest step_order)
        if (existingSteps.length > 0) {
          const lowestStepOrder = Math.min(...existingSteps.map((s: ScheduleStep) => s.stepOrder));
          if (stepOrder > lowestStepOrder) {
            throw new Error('Income allocation schedules must start with the inflow step');
          }
        }
      } else {
        // For non-inflow steps, verify there's already an inflow step if there are no steps yet
        if (existingSteps.length === 0) {
          throw new Error(
            'Income allocation schedules must start with an inflow step before adding other steps'
          );
        }
      }
    } else if (scheduleTypeCode === 'subscription' || scheduleTypeCode === 'payment') {
      // Subscription and payment schedules cannot have inflow steps
      if (stepTypeCode === 'inflow') {
        throw new Error(`${scheduleType.name} schedules cannot have inflow steps`);
      }
    }
    // 'other' schedule type has no restrictions
  }

  /**
   * Validate schedule type restrictions when updating an existing step
   * Similar to validateScheduleTypeRestrictions but excludes the step being updated from existing steps
   */
  private async validateScheduleTypeRestrictionsForUpdate(
    schedule: Schedule,
    stepTypeCode: string,
    stepOrder: number,
    stepId: string,
    tx?: DatabaseTransaction
  ): Promise<void> {
    // Get schedule type to check restrictions
    const scheduleType = await this.scheduleTypeRepository.findById(schedule.typeId, tx);
    if (!scheduleType) {
      return; // If schedule type not found, skip validation
    }

    const scheduleTypeCode = scheduleType.code;

    // Get existing steps for this schedule, excluding the one being updated
    const allSteps = await this.scheduleStepRepository.findBySchedule(schedule.id, tx);
    const existingSteps = allSteps.filter((step: ScheduleStep) => step.id !== stepId);

    if (scheduleTypeCode === 'income_allocation') {
      // Income allocation schedules must start with inflow and have only 1 inflow
      if (stepTypeCode === 'inflow') {
        // Check if there's already another inflow step
        // Fetch step types for existing steps to check their codes
        const stepTypeIds = existingSteps.map((step: ScheduleStep) => step.typeId);
        const existingStepTypes = await Promise.all(
          stepTypeIds.map((typeId) => this.scheduleStepTypeRepository.findById(typeId, tx))
        );
        const hasOtherInflowStep = existingStepTypes.some(
          (stepType) => stepType?.code === 'inflow'
        );

        if (hasOtherInflowStep) {
          throw new Error('Income allocation schedules can have only one inflow step');
        }

        // Check if this would be the first step (lowest step_order)
        if (existingSteps.length > 0) {
          const lowestStepOrder = Math.min(...existingSteps.map((s: ScheduleStep) => s.stepOrder));
          if (stepOrder > lowestStepOrder) {
            throw new Error('Income allocation schedules must start with the inflow step');
          }
        }
      } else {
        // For non-inflow steps, verify there's an inflow step
        // Fetch step types for existing steps to check their codes
        const stepTypeIds = existingSteps.map((step: ScheduleStep) => step.typeId);
        const existingStepTypes = await Promise.all(
          stepTypeIds.map((typeId) => this.scheduleStepTypeRepository.findById(typeId, tx))
        );
        const hasInflowStep = existingStepTypes.some((stepType) => stepType?.code === 'inflow');

        if (!hasInflowStep && existingSteps.length >= 0) {
          throw new Error(
            'Income allocation schedules must have an inflow step. Cannot change the only inflow step to a different type.'
          );
        }
      }
    } else if (scheduleTypeCode === 'subscription' || scheduleTypeCode === 'payment') {
      // Subscription and payment schedules cannot have inflow steps
      if (stepTypeCode === 'inflow') {
        throw new Error(`${scheduleType.name} schedules cannot have inflow steps`);
      }
    }
    // 'other' schedule type has no restrictions
  }
}
