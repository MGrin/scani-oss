import { z } from 'zod';

export const isProduction = process.env.NODE_ENV === 'production';

export const urlSchema = z.string().url({ message: 'must be a valid URL' });

// The refine reads NODE_ENV at parse time (not at module load) so a single
// schema instance handles both dev and prod. In real apps NODE_ENV is stable
// from boot, so this is behaviourally identical to a load-time gate; the
// payoff is that tests can exercise both branches in one process.
export const httpsUrlInProduction = urlSchema.refine(
  (v) => process.env.NODE_ENV !== 'production' || v.startsWith('https://'),
  { message: 'must use https:// in production' }
);

export function requiredInProd<T extends z.ZodString>(
  schema: T,
  varName?: string
): T | z.ZodOptional<T> {
  if (process.env.NODE_ENV !== 'production') return schema.optional();
  if (!varName) return schema;
  // Re-applying min(1) lets us name the variable in the error message;
  // zod's stock "must be at least 1 chars" hides which env var failed.
  return schema.min(1, {
    message: `${varName} is required in production and cannot be empty`,
  }) as unknown as T;
}
