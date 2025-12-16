import { z } from 'zod';

// Schedule base types
export type Schedule = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  repetitiveCronPattern: string;
  typeId: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// Schedule step data types based on step type
export type ScheduleStepInflowData = {
  from: string; // Name of counterparty
  toHoldingId: string; // Holding receiving money
  amount: string; // Amount as string for Decimal.js precision
};

export type ScheduleStepOutflowData = {
  fromHoldingId: string; // Holding sending money
  to: string; // Name of counterparty
  amount: string; // Amount as string for Decimal.js precision
};

export type ScheduleStepTransferData = {
  fromHoldingId: string; // Source holding
  toHoldingId: string; // Destination holding
  amount?: string; // Fixed amount (mutually exclusive with percent)
  percent?: number; // Percentage of inflow amount (mutually exclusive with amount)
};

export type ScheduleStepConversionData = {
  fromHoldingId: string; // Source holding
  toHoldingId: string; // Destination holding
  amount?: string; // Fixed amount (mutually exclusive with percent)
  percent?: number; // Percentage of inflow amount (mutually exclusive with amount)
};

export type ScheduleStep = {
  id: string;
  scheduleId: string;
  typeId: string;
  data:
    | ScheduleStepInflowData
    | ScheduleStepOutflowData
    | ScheduleStepTransferData
    | ScheduleStepConversionData;
  stepOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

// Zod schema for schedule step inflow data
const ScheduleStepInflowDataSchema = z.object({
  from: z.string().min(1).max(200),
  toHoldingId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a valid decimal number'),
});

// Zod schema for schedule step outflow data
const ScheduleStepOutflowDataSchema = z.object({
  fromHoldingId: z.string().uuid(),
  to: z.string().min(1).max(200),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a valid decimal number'),
});

// Zod schema for schedule step transfer data
const ScheduleStepTransferDataSchema = z
  .object({
    fromHoldingId: z.string().uuid(),
    toHoldingId: z.string().uuid(),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'Amount must be a valid decimal number')
      .optional(),
    percent: z.number().min(0).max(100).optional(),
  })
  .refine(
    (data) => {
      // Ensure exactly one of amount or percent is provided
      const hasAmount = data.amount !== undefined && data.amount !== null;
      const hasPercent = data.percent !== undefined && data.percent !== null;
      return (hasAmount && !hasPercent) || (!hasAmount && hasPercent);
    },
    {
      message: 'Exactly one of amount or percent must be provided',
    }
  );

// Zod schema for schedule step conversion data
const ScheduleStepConversionDataSchema = z
  .object({
    fromHoldingId: z.string().uuid(),
    toHoldingId: z.string().uuid(),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'Amount must be a valid decimal number')
      .optional(),
    percent: z.number().min(0).max(100).optional(),
  })
  .refine(
    (data) => {
      // Ensure exactly one of amount or percent is provided
      const hasAmount = data.amount !== undefined && data.amount !== null;
      const hasPercent = data.percent !== undefined && data.percent !== null;
      return (hasAmount && !hasPercent) || (!hasAmount && hasPercent);
    },
    {
      message: 'Exactly one of amount or percent must be provided',
    }
  );

// Create schedule DTO
export const CreateScheduleDto = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  repetitiveCronPattern: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/,
      'Invalid cron pattern format'
    ),
  typeId: z.string().uuid(),
});

export type CreateScheduleInput = z.infer<typeof CreateScheduleDto>;

// Update schedule DTO
export const UpdateScheduleDto = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional().nullable(),
  repetitiveCronPattern: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/,
      'Invalid cron pattern format'
    )
    .optional(),
  typeId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateScheduleInput = z.infer<typeof UpdateScheduleDto>;

// Create schedule step DTO
export const CreateScheduleStepDto = z.object({
  scheduleId: z.string().uuid(),
  typeId: z.string().uuid(),
  stepOrder: z.number().default(0),
  data: z.union([
    ScheduleStepInflowDataSchema,
    ScheduleStepOutflowDataSchema,
    ScheduleStepTransferDataSchema,
    ScheduleStepConversionDataSchema,
  ]),
});

export type CreateScheduleStepInput = z.infer<typeof CreateScheduleStepDto>;

// Update schedule step DTO
export const UpdateScheduleStepDto = z.object({
  typeId: z.string().uuid().optional(),
  stepOrder: z.number().optional(),
  data: z
    .union([
      ScheduleStepInflowDataSchema,
      ScheduleStepOutflowDataSchema,
      ScheduleStepTransferDataSchema,
      ScheduleStepConversionDataSchema,
    ])
    .optional(),
});

export type UpdateScheduleStepInput = z.infer<typeof UpdateScheduleStepDto>;
