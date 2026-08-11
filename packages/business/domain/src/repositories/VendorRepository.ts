import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewVendor, Vendor, VendorAlias } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { normalizeVendorName } from '../lib/normalize-vendor-name';

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
   * Fold `fromId` into `intoId`: reassign its aliases and delete the
   * source row. `intoId` itself, its own aliases, and anything else that
   * references it are never touched — only `fromId`'s row is deleted, and
   * only after everything worth keeping has been moved off it.
   *
   * Ownership is verified for BOTH ids before any write happens. This is
   * a defense-in-depth check, not a substitute for the router-level
   * guard: `merge` is reachable from a mutation that takes two raw ids
   * off the client, and without this check one user could fold another
   * user's vendor into their own — reading its aliases, then deleting it
   * — by simply guessing or enumerating an id.
   *
   * CALLERS MUST PASS `transaction`. The three writes below (dedup
   * delete, alias reassignment, vendor delete) are three separate
   * statements, not one — `getDb` silently falls back to the ambient
   * pool when no transaction is given, and a crash between the
   * reassignment and the vendor delete leaves `fromId` behind as a
   * stale, alias-less duplicate vendor that nothing points at anymore
   * (its aliases already moved to `intoId`, but the row itself never got
   * deleted). Passing a transaction is what makes the three steps
   * commit or roll back together instead of landing in that half-applied
   * state.
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

      await database.delete(schema.vendors).where(eq(schema.vendors.id, fromId));
    } catch (error) {
      this.logger.error({ userId, intoId, fromId, error }, 'Failed to merge vendors');
      throw error;
    }
  }
}
