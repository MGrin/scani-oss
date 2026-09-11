import { z } from 'zod';

/**
 * Which rule turns a sequence of acquisitions and disposals into a gain.
 *
 * Two, and the second is not a refinement of the first — they answer the same
 * question under different law and disagree by whatever the market did in
 * between.
 *
 * - `fifo` — first in, first out. Every figure this product has ever shown was
 *   computed this way, and it is correct for jurisdictions that identify a
 *   disposal against the oldest acquisition. It stays the default for that
 *   reason and because changing a stored figure without being asked is its own
 *   defect (SC-462).
 * - `uk_section_104` — HMRC's share identification rules, which apply to
 *   cryptoassets by the same statute (CRYPTO22200): same-day acquisitions
 *   first (TCGA92/S105(1)), then acquisitions in the 30 days after the
 *   disposal (TCGA92/S106A(5), the "bed and breakfast" rule), then a Section
 *   104 pool held at a running average cost.
 */
export const COST_BASIS_METHODS = ['fifo', 'uk_section_104'] as const;

export type CostBasisMethodDto = (typeof COST_BASIS_METHODS)[number];

export const costBasisMethodSchema = z.enum(COST_BASIS_METHODS);

export const DEFAULT_COST_BASIS_METHOD: CostBasisMethodDto = 'fifo';

/**
 * The stored column read as a method.
 *
 * `users.cost_basis_method` is `text` with a CHECK, so the type system sees a
 * `string` and the database sees the constraint. This is the one place the two
 * are reconciled, and it resolves an unrecognised value to `fifo` rather than
 * throwing: a walk that refuses to run reports no number at all, and the
 * figure this account has always been shown is the FIFO one.
 */
export function parseCostBasisMethod(value: string | null | undefined): CostBasisMethodDto {
  const parsed = costBasisMethodSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_COST_BASIS_METHOD;
}

/**
 * Everything a surface needs to state which rule a reader's figures were
 * computed under, and whether they are still moving (SC-980).
 *
 * Three fields because a screen that shows the method has to answer three
 * questions at once and cannot answer any of them from the others:
 *
 * - `method` — what the figures on every other screen mean right now.
 * - `lookbackDays` — how much recorded history a change rewrites. The
 *   confirmation has to name it, and naming it from a constant compiled into
 *   the bundle would let the sentence and the job disagree after a deploy:
 *   `PORTFOLIO_HISTORY_LOOKBACK_DAYS` lives in `@scani/jobs`, which is not
 *   frontend-safe, so the server is the only honest source for it.
 * - `recomputingJobId` — the backfill currently rewriting those rows, or
 *   null. Held on the SERVER rather than in the tab that started it, because
 *   the failure this exists to prevent is a page that reads as finished while
 *   the numbers are still moving — and a job id kept in React state is lost
 *   by a reload, which is exactly when the page would lie.
 *
 * It reports any in-flight `PORTFOLIO_HISTORY_BACKFILL`, not only one a
 * method change enqueued. That is deliberate and it is what the reader is
 * being told: an import-triggered backfill rewrites the same rows, so "your
 * figures are still settling" is true either way, and a state scoped to one
 * cause would read as settled while they were not.
 */
export const costBasisMethodStateSchema = z.object({
  method: costBasisMethodSchema,
  lookbackDays: z.number().int().positive(),
  recomputingJobId: z.string().nullable(),
});

export type CostBasisMethodState = z.infer<typeof costBasisMethodStateSchema>;
