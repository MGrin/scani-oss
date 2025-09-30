import { z } from 'zod';

const MANUAL_PRICE_MIN = 0.000001;

const manualPriceValueSchema = z.coerce
  .number({
    invalid_type_error: 'Manual price must be a number',
  })
  .min(MANUAL_PRICE_MIN, `Price must be greater than ${MANUAL_PRICE_MIN}`);

const trimmedOptionalString = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

export const privateTokenCreateSchema = z.object({
  symbol: z
    .string({ required_error: 'Symbol is required' })
    .min(1, 'Symbol is required')
    .max(20, 'Symbol must be 20 characters or less'),
  name: z.string({ required_error: 'Name is required' }).min(1, 'Name is required'),
  decimals: z
    .number({ invalid_type_error: 'Decimals must be a number' })
    .int('Decimals must be an integer')
    .min(0, 'Decimals cannot be negative')
    .max(18, 'Decimals must be 18 or less'),
  typeCode: z.enum(['private-company', 'other'], {
    required_error: 'Token type is required',
    invalid_type_error: 'Token type is invalid',
  }),
  description: trimmedOptionalString,
  manualPrice: manualPriceValueSchema,
  priceDescription: trimmedOptionalString,
});

export type PrivateTokenCreateInput = z.infer<typeof privateTokenCreateSchema>;

export const privateTokenUpdateSchema = z
  .object({
    description: trimmedOptionalString,
    manualPrice: manualPriceValueSchema.optional(),
    priceDescription: trimmedOptionalString,
  })
  .superRefine((data, ctx) => {
    if (data.manualPrice !== undefined && !data.priceDescription) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Price update notes are required when providing a manual price',
        path: ['priceDescription'],
      });
    }
  });

export type PrivateTokenUpdateInput = z.infer<typeof privateTokenUpdateSchema>;

export const manualPriceMinimum = MANUAL_PRICE_MIN;
