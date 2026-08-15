import { z } from 'zod';

/**
 * Response schemas shared by more than one router.
 *
 * Every OpenAPI-exposed procedure declares `.output(...)`. Without it
 * `trpc-openapi` has nothing to derive a response schema from and
 * publishes `{}` — the endpoint's TypeScript return annotation is
 * invisible to it (SC-108).
 */

/** A write that either succeeded or threw. Never `{ ok: false }`. */
export const okOutput = z.object({ ok: z.literal(true) });
