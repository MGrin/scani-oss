import { z } from 'zod';

/**
 * Ownership boundaries — the two sets of books a contractor with a limited
 * company keeps (SC-463).
 *
 * **Not tax output.** SC-90 is parked
 * (`docs/technical/2026-08-14_why-no-tax-statement.md`) and separating the
 * books does not reopen it. Nothing here may acquire a tax framing — not a
 * field, not a heading, not a route.
 */

/** The literal id of the bucket holding every account nobody has classified. */
export const UNASSIGNED_ENTITY = 'unassigned';

const entityValueSchema = z.object({
  /** An entity's id, or the literal `'unassigned'`. */
  entityId: z.string(),
  /** Decimal string, base currency. */
  value: z.string(),
  holdingsCounted: z.number(),
  /** Symbols inside this boundary we could not price — unknown, not zero. */
  unpricedSymbols: z.array(z.string()),
});

/**
 * Per-boundary totals and the combined view, in one response.
 *
 * They travel together deliberately. The number a person checks is
 * `sum(entities) + unassigned === totalValue`, and shipping the parts and the
 * whole from one call is what stops a screen from pairing today's parts with a
 * total it fetched separately — two reads of a moving portfolio that would
 * disagree for reasons that have nothing to do with this feature.
 */
export const entityValuationSchema = z.object({
  baseCurrency: z.string(),
  /** Net worth across every boundary. The same figure the home screen shows. */
  totalValue: z.string(),
  entities: z.array(entityValueSchema),
  unassigned: entityValueSchema,
});
