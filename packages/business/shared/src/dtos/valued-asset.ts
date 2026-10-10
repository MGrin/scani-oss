import { z } from 'zod';
import { movementAmount } from './holding-movement';

/**
 * A calendar day, YYYY-MM-DD, no later than today in UTC. A valuation is a
 * claim about a day, not an instant, and a day in the future is a forecast
 * rather than a value (SC-1643).
 */
const pastOrTodayDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expected a day as YYYY-MM-DD' })
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'Not a real day',
  })
  .refine((value) => value <= new Date().toISOString().slice(0, 10), {
    message: 'The day cannot be in the future',
  });

const PropertyDetails = z.object({
  kind: z.literal('property'),
  address: z.string().trim().max(300).optional(),
  areaSqm: z.number().positive().optional(),
});

const VehicleDetails = z.object({
  kind: z.literal('vehicle'),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  year: z
    .number()
    .int()
    .min(1886)
    .refine((year) => year <= new Date().getUTCFullYear() + 1, {
      message: 'A model year at most next year',
    })
    .optional(),
  mileageKm: z.number().nonnegative().optional(),
});

/** What a valued asset is, beyond its value. Stored metric; shown by locale. */
export const ValuedAssetDetailsDto = z.discriminatedUnion('kind', [
  PropertyDetails,
  VehicleDetails,
]);
export type ValuedAssetDetails = z.infer<typeof ValuedAssetDetailsDto>;

export const CreateValuedAssetDto = z.object({
  name: z.string().trim().min(1).max(200),
  currencyCode: z.string().trim().min(3).max(10),
  purchaseDate: pastOrTodayDay,
  purchasePrice: movementAmount,
  currentValue: movementAmount.optional(),
  details: ValuedAssetDetailsDto,
});
export type CreateValuedAsset = z.infer<typeof CreateValuedAssetDto>;

export const AddValuationDto = z.object({
  holdingId: z.string().uuid(),
  occurredOn: pastOrTodayDay,
  value: movementAmount,
});
export type AddValuation = z.infer<typeof AddValuationDto>;

export const UpdateValuedAssetDetailsDto = z.object({
  holdingId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  details: ValuedAssetDetailsDto,
});
export type UpdateValuedAssetDetails = z.infer<typeof UpdateValuedAssetDetailsDto>;
