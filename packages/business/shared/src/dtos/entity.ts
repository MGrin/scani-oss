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

export type Entity = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export const CreateEntityDto = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional().nullable(),
});

export type CreateEntityInput = z.infer<typeof CreateEntityDto>;

export const UpdateEntityDto = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional().nullable(),
});

export type UpdateEntityInput = z.infer<typeof UpdateEntityDto>;

/**
 * Move accounts into a boundary, or out of every boundary with a null
 * `entityId`.
 *
 * Accounts rather than holdings, and that is the model rather than a
 * convenience: `holdings.account_id` is NOT NULL, so assigning the account
 * partitions its holdings for free and no holding can be in two boundaries or
 * in none.
 */
export const AssignAccountsToEntityDto = z.object({
  accountIds: z.array(z.string().uuid()).min(1),
  entityId: z.string().uuid().nullable(),
});

export type AssignAccountsToEntityInput = z.infer<typeof AssignAccountsToEntityDto>;

/** The literal id of the bucket holding every account nobody has classified. */
export const UNASSIGNED_ENTITY = 'unassigned';

export const entityValueSchema = z.object({
  /** An entity's id, or the literal `'unassigned'`. */
  entityId: z.string(),
  /** Decimal string, base currency. */
  value: z.string(),
  holdingsCounted: z.number(),
  /** Symbols inside this boundary we could not price — unknown, not zero. */
  unpricedSymbols: z.array(z.string()),
});

export type EntityValueDto = z.infer<typeof entityValueSchema>;

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

export type EntityValuationDto = z.infer<typeof entityValuationSchema>;
