import type { Schedule } from '../domain/entities';

/**
 * Interval units supported for schedule repetition
 */
export type IntervalUnit = 'd' | 'w' | 'M' | 'y';

/**
 * Parsed interval object
 */
export interface ParsedInterval {
  value: number;
  unit: IntervalUnit;
}

/**
 * Parse an interval string like "2w" or "3M" into value and unit
 */
export function parseInterval(interval: string): ParsedInterval {
  const match = interval.match(/^(\d+)(d|w|M|y)$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid interval format: ${interval}`);
  }
  return {
    value: Number.parseInt(match[1], 10),
    unit: match[2] as IntervalUnit,
  };
}

/**
 * Calculate the next execution date based on the interval and start date
 */
export function calculateNextExecutionDate(
  intervalStartDate: Date,
  interval: string,
  lastExecuted?: Date | null
): Date {
  const parsed = parseInterval(interval);

  // If never executed, use the interval start date
  if (!lastExecuted) {
    return new Date(intervalStartDate);
  }

  const nextDate = new Date(lastExecuted);

  switch (parsed.unit) {
    case 'd': // days
      nextDate.setDate(nextDate.getDate() + parsed.value);
      break;
    case 'w': // weeks
      nextDate.setDate(nextDate.getDate() + parsed.value * 7);
      break;
    case 'M': // months
      nextDate.setMonth(nextDate.getMonth() + parsed.value);
      break;
    case 'y': // years
      nextDate.setFullYear(nextDate.getFullYear() + parsed.value);
      break;
    default:
      throw new Error(`Unsupported interval unit: ${parsed.unit}`);
  }

  return nextDate;
}

/**
 * Check if a schedule should execute now based on interval configuration
 */
export function shouldExecuteInterval(schedule: Schedule, now: Date = new Date()): boolean {
  // If no interval, this is not an interval-based schedule
  if (!schedule.interval || !schedule.intervalStartDate) {
    return false;
  }

  // If schedule is not active, never execute
  if (!schedule.isActive) {
    return false;
  }

  const nextExecution = calculateNextExecutionDate(
    schedule.intervalStartDate,
    schedule.interval,
    schedule.lastExecuted
  );

  // Should execute if current time is at or past the next execution time
  return now >= nextExecution;
}

/**
 * Check if a schedule should execute based on cron pattern
 * This is a placeholder - actual cron matching would need a cron library
 */
export function shouldExecuteCron(schedule: Schedule, _now: Date = new Date()): boolean {
  // If no cron pattern, this is not a cron-based schedule
  if (!schedule.repetitiveCronPattern) {
    return false;
  }

  // If schedule is not active, never execute
  if (!schedule.isActive) {
    return false;
  }

  // TODO: Implement proper cron pattern matching
  // This would require a library like 'cron-parser' or 'node-cron'
  // For now, we just return false as a placeholder
  return false;
}

/**
 * Check if any schedule (cron or interval-based) should execute now
 */
export function shouldExecuteSchedule(schedule: Schedule, now: Date = new Date()): boolean {
  if (schedule.interval) {
    return shouldExecuteInterval(schedule, now);
  }
  if (schedule.repetitiveCronPattern) {
    return shouldExecuteCron(schedule, now);
  }
  return false;
}

/**
 * Get a human-readable description of the schedule interval
 */
export function getIntervalDescription(interval: string): string {
  const parsed = parseInterval(interval);
  const unitNames: Record<IntervalUnit, string> = {
    d: 'day',
    w: 'week',
    M: 'month',
    y: 'year',
  };

  const unitName = unitNames[parsed.unit];
  const plural = parsed.value !== 1 ? 's' : '';

  return `Every ${parsed.value} ${unitName}${plural}`;
}
