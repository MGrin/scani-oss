/**
 * `@scani/config`
 *
 * Shared env-validation helpers used by every app's startup schema. Lives
 * in its own package so that `requiredInProd` + the production URL shapes
 * don't get copy-pasted across `apps/backend/src/config/env.ts`,
 * `apps/worker/src/config/env.ts`, and any future service.
 */

import { z } from 'zod';

/** `true` iff NODE_ENV is "production". Evaluated once at module load. */
export const isProduction = process.env.NODE_ENV === 'production';

/** A zod shape that accepts any syntactically valid URL. */
export const urlSchema = z.string().url({ message: 'must be a valid URL' });

/**
 * Like `urlSchema` but additionally requires `https://` in production.
 * Use for any URL that must not leak plaintext over the wire in prod
 * (OAuth callbacks, session cookie targets, public frontend origins).
 */
export const httpsUrlInProduction = isProduction
  ? urlSchema.refine((v) => v.startsWith('https://'), {
      message: 'must use https:// in production',
    })
  : urlSchema;

/**
 * Mark a string schema as required in production, optional in dev.
 *
 * Used for secrets that must exist when the process runs against a real
 * user base (API keys, signing keys) but that a local dev loop can leave
 * unset without crashing. The caller composes it as
 * `requiredInProd(z.string().min(1), 'API_KEY')` etc.
 *
 * The optional `varName` is woven into the zod error message so that
 * the "must be at least 1 chars" generic doesn't hide which variable
 * actually tripped validation — users set blank strings in their env
 * files and the stock message is unhelpful.
 */
export function requiredInProd<T extends z.ZodString>(
  schema: T,
  varName?: string
): T | z.ZodOptional<T> {
  if (!isProduction) return schema.optional();
  if (!varName) return schema;
  // Rewrap the schema with a friendly min(1) message so blank-string
  // failures name the variable.
  return schema.min(1, {
    message: `${varName} is required in production and cannot be empty`,
  }) as unknown as T;
}
