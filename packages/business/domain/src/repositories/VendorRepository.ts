import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewVendor, Vendor, VendorAlias } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { normalizeVendorName } from '../lib/normalize-vendor-name';
import {
  VENDOR_MATCH_AUTO_THRESHOLD,
  VENDOR_MATCH_SUGGEST_THRESHOLD,
  vendorMatchKey,
} from '../lib/vendor-match-key';

/**
 * How a raw string got to a vendor. `exact` is one of the two verbatim tiers
 * (canonical `normalizedName`, or a recorded alias); `canonical` is equality on
 * `matchKey`, i.e. the same name wearing a different legal form; `similar` is a
 * trigram score at or above `VENDOR_MATCH_AUTO_THRESHOLD`.
 */
export type VendorMatchTier = 'exact' | 'canonical' | 'similar';

export interface VendorMatch {
  vendor: Vendor;
  tier: VendorMatchTier;
  /** 1 for both exact tiers and for a `matchKey` equality. */
  score: number;
}

export interface VendorCandidate {
  vendor: Vendor;
  score: number;
  /**
   * True when this candidate is confident enough that `resolve` would reuse it
   * without asking. A surface offering candidates has to distinguish the two:
   * "saving will reuse Hetzner Online GmbH" is a statement, "did you mean
   * Hetzner Online GmbH?" is a question.
   */
  autoReuse: boolean;
}

export interface FindCandidatesOptions {
  limit?: number;
  minScore?: number;
}

/** One vendor's settled money in one currency, on one side of the ledger. */
export interface VendorSettledSpend {
  vendorId: string;
  currencyTokenId: string;
  /** `outflow` — money paid to the vendor. `inflow` — money received from it. */
  direction: string;
  allTime: string;
  /** The same sum restricted to occurrences due on or after the window start. */
  inWindow: string;
  settledCount: number;
  /** Settled occurrences with no amount anywhere — absent from both sums. */
  unpricedCount: number;
}

export interface VendorSettledOccurrence {
  id: string;
  vendorId: string;
  paymentId: string;
  dueDate: string;
  amount: string | null;
  currencyTokenId: string;
  direction: string;
}

/** What a delete would take with it, and what stands in its way. */
export interface VendorDeleteImpact {
  /** Payments still pointing at this vendor. Any at all blocks the delete. */
  payments: number;
  /** Aliases, which `vendors.vendor_id` cascades away. */
  aliases: number;
  /** Extractions whose resolved vendor link is nulled by the delete. */
  extractions: number;
}

/**
 * Raised for both "no such vendor" and "belongs to someone else" — the
 * caller maps it to a plain NOT_FOUND, same precedent as `vendors.get`, so
 * it can't be used to probe for another user's vendor ids.
 */
export class VendorNotFoundError extends Error {
  constructor(vendorId: string) {
    super(`Vendor ${vendorId} not found`);
    this.name = 'VendorNotFoundError';
  }
}

/**
 * Raised when a rename would land on a name the user already has.
 *
 * A rename is NOT an implicit merge, and this error is where that decision
 * lives. `create` is get-or-create because "give me a vendor called AWS"
 * has one right answer whether or not the row exists; a rename is
 * "change THIS row", and folding it into the collision target would delete
 * a record the reader never named. Merge already exists as the deliberate
 * version of that, with a chooser and a sentence stating what moves — and
 * a rename can state none of it, because the reader typed a name rather
 * than picking a victim.
 *
 * Carries the survivor so the surface can name it and point at Merge.
 */
export class VendorNameConflictError extends Error {
  constructor(
    readonly conflictingVendorId: string,
    readonly conflictingDisplayName: string
  ) {
    super(`Another vendor is already called "${conflictingDisplayName}"`);
    this.name = 'VendorNameConflictError';
  }
}

/**
 * Raised when a delete would have to destroy payments to succeed.
 *
 * `payments.vendor_id` is ON DELETE RESTRICT, so the database refuses this
 * anyway — but it refuses with a constraint name. The three ways out were
 * weighed in SC-83:
 *
 * - CASCADE deletes the payments and, through them, every settled
 *   occurrence: money that really moved, with its matched transaction and
 *   the invoice it was settled from. Removing a duplicate name is not a
 *   reason to destroy financial history, and this is the same failure
 *   SC-31 found in `merge` pointing the other way.
 * - REASSIGN needs a target vendor to move them to, which is exactly what
 *   `merge` is. A second path to that write would be a second sentence
 *   describing it, and the two would drift.
 * - REFUSE, with the count, leaves delete meaning one thing: remove a
 *   vendor nothing depends on — a typo, a test, a name the extractor took
 *   verbatim off an invoice.
 */
export class VendorHasPaymentsError extends Error {
  constructor(readonly paymentCount: number) {
    super(
      `Vendor still has ${paymentCount} payment${paymentCount === 1 ? '' : 's'} pointing at it`
    );
    this.name = 'VendorHasPaymentsError';
  }
}

// `23505` is unique_violation. Matched on the constraint name too, so a
// different unique index on `vendors` could never be reported to the reader
// as "that name is taken". postgres.js hangs both off the error object.
function isUniqueNormalizedNameViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint_name?: unknown };
  return (
    candidate.code === '23505' && candidate.constraint_name === 'vendors_user_normalized_unique'
  );
}

// Who a user pays or is paid by. Never an institution — AWS is a
// vendor, Wise (where the money moves through) is an institution.
//
// `vendors.normalizedName` collapses trivial spelling noise (see
// `normalizeVendorName` in `@scani/domain/lib/normalize-vendor-name`);
// `vendor_aliases` is the mechanism for pointing genuinely
// differently-spelled raw strings ("AMZN Mktp GB", "Amazon.co.uk") at
// one vendor — that's a deliberate human/system decision via `addAlias`,
// never automatic.
@Service()
export class VendorRepository extends BaseRepository<Vendor, NewVendor> {
  protected readonly table = schema.vendors;
  protected readonly tableName = 'vendors';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Vendor[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.vendors)
        .where(eq(schema.vendors.userId, userId))
        .orderBy(schema.vendors.displayName);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find vendors by user');
      throw error;
    }
  }

  /**
   * Resolve a raw string (a bank-statement counterparty, a document's
   * extracted vendor name, …) to an existing vendor, scoped to the user.
   * Checked in two tiers: the vendor's own canonical `normalizedName`
   * first (handles case/punctuation/whitespace variance of the SAME
   * string), then a verbatim lookup against `vendor_aliases.rawName`
   * (handles a raw string that's been explicitly aliased).
   *
   * Exact-only, on purpose. Near-duplicate handling lives one level up in
   * `resolve`, which calls this first — so an exact match never pays for a
   * similarity scan it doesn't need.
   */
  async findByAlias(
    userId: string,
    rawName: string,
    transaction?: DatabaseTransaction
  ): Promise<Vendor | undefined> {
    try {
      const database = this.getDb(transaction);
      const normalizedName = normalizeVendorName(rawName);

      const byNormalizedName = await database
        .select()
        .from(schema.vendors)
        .where(
          and(eq(schema.vendors.userId, userId), eq(schema.vendors.normalizedName, normalizedName))
        )
        .limit(1);
      if (byNormalizedName[0]) return byNormalizedName[0];

      const byAlias = await database
        .select({ vendor: schema.vendors })
        .from(schema.vendorAliases)
        .innerJoin(schema.vendors, eq(schema.vendorAliases.vendorId, schema.vendors.id))
        .where(and(eq(schema.vendors.userId, userId), eq(schema.vendorAliases.rawName, rawName)))
        .limit(1);
      return byAlias[0]?.vendor;
    } catch (error) {
      this.logger.error({ userId, rawName, error }, 'Failed to find vendor by alias');
      throw error;
    }
  }

  /**
   * The only way a vendor row should be minted: one place that derives
   * `normalizedName` from `displayName`, so the exact tier can never be fed a
   * key some caller normalised its own way. `matchKey` is not set here — it is
   * a generated column, computed by Postgres from `normalizedName`.
   */
  async createForUser(
    userId: string,
    input: { displayName: string; category?: string | null; website?: string | null },
    transaction?: DatabaseTransaction
  ): Promise<Vendor> {
    const displayName = input.displayName.trim();
    return this.create(
      {
        userId,
        displayName,
        normalizedName: normalizeVendorName(displayName),
        category: input.category ?? null,
        website: input.website ?? null,
      },
      transaction
    );
  }

  /**
   * Change what a person chose about a vendor — its display name, its
   * category, its website. The only write path that rewrites an existing
   * row, and the counterpart to `createForUser`: it derives
   * `normalizedName` from `displayName` in the same one place, so a rename
   * cannot leave the exact-match tier pointing at the old spelling.
   *
   * `matchKey` is never written here. It is `GENERATED ALWAYS` off
   * `normalizedName`, so Postgres recomputes it as part of this UPDATE —
   * setting it would be rejected, and deriving it in TypeScript would be
   * the second definition the column exists to prevent.
   *
   * Aliases are left exactly as they are. An alias records a raw string the
   * vendor has genuinely been seen under ("AMZN Mktp GB"); renaming the
   * vendor does not make that string untrue, and dropping them would
   * silently break every future match that string resolves through.
   *
   * A rename onto another vendor's name throws rather than merging — see
   * `VendorNameConflictError` for that argument. The pre-check is what makes
   * the refusal nameable; `vendors_user_normalized_unique` is still there
   * underneath it for the race.
   */
  async updateForUser(
    userId: string,
    vendorId: string,
    input: {
      displayName?: string;
      category?: string | null;
      website?: string | null;
    },
    transaction?: DatabaseTransaction
  ): Promise<Vendor> {
    const database = this.getDb(transaction);
    const existing = await this.findById(vendorId, transaction);
    if (!existing || existing.userId !== userId) {
      throw new VendorNotFoundError(vendorId);
    }

    const patch: Partial<Vendor> = { updatedAt: new Date() };

    if (input.displayName !== undefined) {
      const displayName = input.displayName.trim();
      const normalizedName = normalizeVendorName(displayName);
      // Only a change in the COLLISION key can collide. Recasing "aws" to
      // "AWS" normalises to the same string, and refusing that would make
      // the one rename people most want impossible.
      if (normalizedName !== existing.normalizedName) {
        const [clash] = await database
          .select()
          .from(schema.vendors)
          .where(
            and(
              eq(schema.vendors.userId, userId),
              eq(schema.vendors.normalizedName, normalizedName),
              ne(schema.vendors.id, vendorId)
            )
          )
          .limit(1);
        if (clash) {
          throw new VendorNameConflictError(clash.id, clash.displayName);
        }
      }
      patch.displayName = displayName;
      patch.normalizedName = normalizedName;
    }

    if (input.category !== undefined) patch.category = input.category;
    if (input.website !== undefined) patch.website = input.website;

    try {
      const updated = await this.update(vendorId, patch, transaction);
      if (!updated) throw new VendorNotFoundError(vendorId);
      return updated;
    } catch (error) {
      // The pre-check above answers for everything but a concurrent rename
      // landing between the SELECT and the UPDATE. Mapping the constraint
      // keeps that race arriving as the same refusal rather than a 500.
      if (isUniqueNormalizedNameViolation(error)) {
        throw new VendorNameConflictError(vendorId, input.displayName?.trim() ?? '');
      }
      throw error;
    }
  }

  /**
   * What deleting this vendor would do, so a confirmation can say it before
   * the reader agrees to it. Counts only, and the same shape as
   * `mergeImpact` — the two confirmations ask about the same three things.
   *
   * Ownership is verified here for the reason `mergeImpact` verifies it: a
   * count is a smaller disclosure than a delete, but it is still one.
   */
  async deleteImpact(
    userId: string,
    vendorId: string,
    transaction?: DatabaseTransaction
  ): Promise<VendorDeleteImpact> {
    const database = this.getDb(transaction);
    const existing = await this.findById(vendorId, transaction);
    if (!existing || existing.userId !== userId) {
      throw new VendorNotFoundError(vendorId);
    }

    const [payments] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.payments)
      .where(eq(schema.payments.vendorId, vendorId));

    const [aliases] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.vendorAliases)
      .where(eq(schema.vendorAliases.vendorId, vendorId));

    const [extractions] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.documentExtractions)
      .where(eq(schema.documentExtractions.vendorId, vendorId));

    return {
      payments: payments?.count ?? 0,
      aliases: aliases?.count ?? 0,
      extractions: extractions?.count ?? 0,
    };
  }

  /**
   * Remove a vendor nothing depends on.
   *
   * Refuses while any payment still points at it — see
   * `VendorHasPaymentsError` for why refuse rather than cascade or
   * reassign. The count is read inside the same call that deletes, so the
   * refusal is decided on the row set the delete would actually meet
   * rather than on a preview the reader saw some seconds ago.
   *
   * Aliases go with it (`vendor_aliases.vendor_id` is ON DELETE CASCADE)
   * and document extractions keep their row with `vendor_id` set to null —
   * which is the SILENT half of the SC-31 bug, so `deleteImpact` reports
   * that count and the confirmation is required to name it. An extraction
   * survives the loss: `vendor_name_raw` is `notNull`, so what the invoice
   * actually said is never what gets destroyed here.
   *
   * CALLERS SHOULD PASS `transaction`. The count and the delete are two
   * statements, and without one a payment created between them lands on a
   * vendor that no longer exists — which the FK would then refuse, leaving
   * the reader a constraint error instead of the sentence they were shown.
   */
  async deleteForUser(
    userId: string,
    vendorId: string,
    transaction?: DatabaseTransaction
  ): Promise<VendorDeleteImpact> {
    try {
      const impact = await this.deleteImpact(userId, vendorId, transaction);
      if (impact.payments > 0) {
        throw new VendorHasPaymentsError(impact.payments);
      }
      await this.delete(vendorId, transaction);
      return impact;
    } catch (error) {
      if (error instanceof VendorNotFoundError || error instanceof VendorHasPaymentsError)
        throw error;
      this.logger.error({ userId, vendorId, error }, 'Failed to delete vendor');
      throw error;
    }
  }

  /**
   * The full resolution ladder, and the method every "reuse or create?"
   * decision should go through. Runs the two exact tiers first via
   * `findByAlias` — an exact match stays exact, cheap and unchanged — then
   * falls back to similarity.
   *
   * Returns a match ONLY at a confidence that justifies acting without asking:
   * `matchKey` equality (the legal-form case this ticket was filed about) or a
   * trigram score at or above `VENDOR_MATCH_AUTO_THRESHOLD`. Anything weaker is
   * deliberately not returned here — attaching a bill to the wrong company is
   * worse than creating a duplicate, so the weaker band is `findCandidates`'
   * job to surface and a human's job to decide.
   */
  async resolve(
    userId: string,
    rawName: string,
    transaction?: DatabaseTransaction
  ): Promise<VendorMatch | undefined> {
    const exact = await this.findByAlias(userId, rawName, transaction);
    if (exact) return { vendor: exact, tier: 'exact', score: 1 };

    const [best] = await this.findCandidates(
      userId,
      rawName,
      { limit: 1, minScore: VENDOR_MATCH_AUTO_THRESHOLD },
      transaction
    );
    if (!best) return undefined;

    return {
      vendor: best.vendor,
      tier: best.score >= 1 ? 'canonical' : 'similar',
      score: best.score,
    };
  }

  /**
   * Existing vendors whose name is close to `rawName`, best first, scored.
   * Everything at or above `VENDOR_MATCH_SUGGEST_THRESHOLD` comes back — the
   * band below `VENDOR_MATCH_AUTO_THRESHOLD` included, flagged `autoReuse:
   * false`, because a candidate the system refuses to act on is exactly the one
   * worth showing a human.
   */
  async findCandidates(
    userId: string,
    rawName: string,
    options: FindCandidatesOptions = {},
    transaction?: DatabaseTransaction
  ): Promise<VendorCandidate[]> {
    try {
      const key = vendorMatchKey(rawName);
      if (!key) return [];

      const limit = options.limit ?? 5;
      const minScore = options.minScore ?? VENDOR_MATCH_SUGGEST_THRESHOLD;
      const database = this.getDb(transaction);
      const score = sql<number>`similarity(${schema.vendors.matchKey}, ${key})::float8`;

      const rows = await database
        .select({ vendor: schema.vendors, score })
        .from(schema.vendors)
        .where(
          and(
            eq(schema.vendors.userId, userId),
            // The equality arm is not redundant with `%`: `%` answers against
            // `pg_trgm.similarity_threshold`, a session GUC nothing here owns,
            // so a raised threshold could otherwise hide the one tier that must
            // never be missed.
            sql`(${schema.vendors.matchKey} = ${key} OR ${schema.vendors.matchKey} % ${key})`
          )
        )
        .orderBy(desc(score), asc(schema.vendors.createdAt))
        .limit(limit);

      return rows
        .filter((row) => row.score >= minScore)
        .map((row) => ({
          vendor: row.vendor,
          score: row.score,
          autoReuse: row.score >= VENDOR_MATCH_AUTO_THRESHOLD,
        }));
    } catch (error) {
      this.logger.error({ userId, rawName, error }, 'Failed to find vendor candidates');
      throw error;
    }
  }

  /**
   * Record that `rawName` has been seen for `vendorId`. Idempotent —
   * calling twice with the same `(vendorId, rawName)` updates `source`
   * rather than throwing on the unique constraint.
   */
  async addAlias(
    vendorId: string,
    rawName: string,
    source?: string,
    transaction?: DatabaseTransaction
  ): Promise<VendorAlias> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .insert(schema.vendorAliases)
        .values({ vendorId, rawName, source })
        .onConflictDoUpdate({
          target: [schema.vendorAliases.vendorId, schema.vendorAliases.rawName],
          set: { source },
        })
        .returning();
      if (!row) throw new Error('Failed to add vendor alias');
      return row;
    } catch (error) {
      this.logger.error({ vendorId, rawName, error }, 'Failed to add vendor alias');
      throw error;
    }
  }

  /**
   * What a merge would move, for a caller that has to state the
   * consequence before asking for it. Counts only — the confirmation
   * needs "3 payments move", never the payments themselves.
   *
   * Ownership is verified here for the same reason `merge` verifies it:
   * both ids arrive off the client, and a count is still a disclosure.
   * `aliases` is the number that will SURVIVE the move — a raw name
   * already aliased to `intoId` is deduped away by `merge` rather than
   * reassigned, so counting the source's rows verbatim would promise the
   * reader more than arrives.
   */
  async mergeImpact(
    userId: string,
    intoId: string,
    fromId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ payments: number; aliases: number; extractions: number }> {
    try {
      const database = this.getDb(transaction);

      const owned = await database
        .select({ id: schema.vendors.id })
        .from(schema.vendors)
        .where(
          and(eq(schema.vendors.userId, userId), inArray(schema.vendors.id, [intoId, fromId]))
        );
      if (owned.length !== 2) {
        throw new Error(
          `Cannot describe merge: ${intoId} and ${fromId} must both belong to user ${userId}`
        );
      }

      const [payments] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.payments)
        .where(eq(schema.payments.vendorId, fromId));

      const [aliases] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.vendorAliases)
        .where(
          and(
            eq(schema.vendorAliases.vendorId, fromId),
            sql`${schema.vendorAliases.rawName} NOT IN (
              SELECT raw_name FROM vendor_aliases WHERE vendor_id = ${intoId}
            )`
          )
        );

      const [extractions] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.documentExtractions)
        .where(eq(schema.documentExtractions.vendorId, fromId));

      return {
        payments: payments?.count ?? 0,
        aliases: aliases?.count ?? 0,
        extractions: extractions?.count ?? 0,
      };
    } catch (error) {
      this.logger.error({ userId, intoId, fromId, error }, 'Failed to describe vendor merge');
      throw error;
    }
  }

  /**
   * Fold `fromId` into `intoId`: reassign everything that pointed at the
   * source — aliases, payments, document extractions — and delete the
   * source row. `intoId` itself, its own aliases, and anything else that
   * references it are never touched, and `fromId`'s row is deleted only
   * after everything worth keeping has been moved off it.
   *
   * The payment and extraction reassignments are what make this a merge
   * rather than a deletion, and neither is optional. `payments.vendor_id`
   * is ON DELETE RESTRICT, so before they moved, merging any vendor that
   * had a single payment failed outright on `payments_vendor_id_fkey` —
   * which meant merge only ever worked on the vendors nobody needed to
   * merge. `document_extractions.vendor_id` is ON DELETE SET NULL, so it
   * failed the other way: the delete succeeded and silently cut every
   * extraction's link to the vendor it had been resolved to.
   *

   * Ownership is verified for BOTH ids before any write happens. This is
   * a defense-in-depth check, not a substitute for the router-level
   * guard: `merge` is reachable from a mutation that takes two raw ids
   * off the client, and without this check one user could fold another
   * user's vendor into their own — reading its aliases, then deleting it
   * — by simply guessing or enumerating an id.
   *
   * CALLERS MUST PASS `transaction`. The writes below (dedup delete,
   * alias reassignment, payment reassignment, extraction reassignment,
   * vendor delete) are separate statements, not one — `getDb` silently
   * falls back to the ambient pool when no transaction is given, and a
   * crash partway through leaves `fromId` behind as a stale duplicate
   * that nothing points at anymore (its aliases and payments already
   * moved to `intoId`, but the row itself never got deleted). Passing a
   * transaction is what makes the steps commit or roll back together
   * instead of landing in that half-applied state.
   */
  async merge(
    userId: string,
    intoId: string,
    fromId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);

      const owned = await database
        .select({ id: schema.vendors.id })
        .from(schema.vendors)
        .where(
          and(eq(schema.vendors.userId, userId), inArray(schema.vendors.id, [intoId, fromId]))
        );
      if (owned.length !== 2) {
        throw new Error(
          `Cannot merge vendors: ${intoId} and ${fromId} must both belong to user ${userId}`
        );
      }

      // An alias with the same raw_name may already exist under `intoId`
      // (e.g. both vendors were independently aliased to the same
      // string) — reassigning would violate `vendor_aliases_unique`.
      // Drop the source's duplicate rather than fail the merge.
      await database.execute(sql`
        DELETE FROM vendor_aliases
        WHERE vendor_id = ${fromId}
          AND raw_name IN (
            SELECT raw_name FROM vendor_aliases WHERE vendor_id = ${intoId}
          )
      `);

      await database
        .update(schema.vendorAliases)
        .set({ vendorId: intoId })
        .where(eq(schema.vendorAliases.vendorId, fromId));

      await database
        .update(schema.payments)
        .set({ vendorId: intoId })
        .where(eq(schema.payments.vendorId, fromId));

      await database
        .update(schema.documentExtractions)
        .set({ vendorId: intoId })
        .where(eq(schema.documentExtractions.vendorId, fromId));

      await database.delete(schema.vendors).where(eq(schema.vendors.id, fromId));
    } catch (error) {
      this.logger.error({ userId, intoId, fromId, error }, 'Failed to merge vendors');
      throw error;
    }
  }

  /**
   * What the user has actually settled with each vendor, per currency and
   * per direction, in ONE aggregate.
   *
   * "How much do I pay this vendor" is answered from `matched` occurrences
   * only — a `scheduled` row is a plan and a `skipped` one is money that
   * never moved, and folding either into a paid figure would be a different
   * claim than the one the label makes.
   *
   * Grouped by direction because a vendor can be on both sides of the ledger
   * (an employer is a vendor with inflow), and adding a salary into a spend
   * total would be the same mistake in the other direction.
   *
   * `unpricedCount` is the count of settled occurrences carrying no amount at
   * any of the three levels. They cannot be summed and are NOT counted as
   * zero silently: a caller that shows the total is expected to say how many
   * settlements are missing from it.
   */
  async settledSpendByUser(
    userId: string,
    windowStart: string,
    transaction?: DatabaseTransaction
  ): Promise<VendorSettledSpend[]> {
    const database = this.getDb(transaction);
    try {
      const rows = (await database.execute(sql`
        SELECT
          p.vendor_id AS "vendorId",
          p.currency_token_id AS "currencyTokenId",
          p.direction AS "direction",
          COALESCE(SUM(COALESCE(o.actual_amount, o.expected_amount, p.expected_amount)::numeric), 0)::text
            AS "allTime",
          COALESCE(SUM(COALESCE(o.actual_amount, o.expected_amount, p.expected_amount)::numeric)
            FILTER (WHERE o.due_date >= ${windowStart}::date), 0)::text AS "inWindow",
          COUNT(*)::int AS "settledCount",
          COUNT(*) FILTER (
            WHERE COALESCE(o.actual_amount, o.expected_amount, p.expected_amount) IS NULL
          )::int AS "unpricedCount"
        FROM payment_occurrences o
        JOIN payments p ON p.id = o.payment_id
        WHERE p.user_id = ${userId} AND o.status = 'matched'
        GROUP BY p.vendor_id, p.currency_token_id, p.direction
      `)) as unknown as VendorSettledSpend[];
      return rows;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to aggregate settled vendor spend');
      throw error;
    }
  }

  /**
   * The last few settlements per vendor, for every vendor, in one query.
   *
   * Windowed rather than fetched per open record: the peek sheet opens on a
   * tap and the vendor list is the surface it opens from, so a per-vendor
   * round trip would be N+1 against exactly the list this feeds.
   */
  async recentSettledByUser(
    userId: string,
    perVendor: number,
    transaction?: DatabaseTransaction
  ): Promise<VendorSettledOccurrence[]> {
    const database = this.getDb(transaction);
    try {
      const rows = (await database.execute(sql`
        SELECT "id", "vendorId", "paymentId", "dueDate", "amount", "currencyTokenId", "direction"
        FROM (
          SELECT
            o.id AS "id",
            p.vendor_id AS "vendorId",
            p.id AS "paymentId",
            o.due_date::text AS "dueDate",
            COALESCE(o.actual_amount, o.expected_amount, p.expected_amount) AS "amount",
            p.currency_token_id AS "currencyTokenId",
            p.direction AS "direction",
            ROW_NUMBER() OVER (
              PARTITION BY p.vendor_id ORDER BY o.due_date DESC, o.id DESC
            ) AS rank
          FROM payment_occurrences o
          JOIN payments p ON p.id = o.payment_id
          WHERE p.user_id = ${userId} AND o.status = 'matched'
        ) ranked
        WHERE rank <= ${perVendor}
        ORDER BY "dueDate" DESC
      `)) as unknown as VendorSettledOccurrence[];
      return rows;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to load recent vendor settlements');
      throw error;
    }
  }
}
