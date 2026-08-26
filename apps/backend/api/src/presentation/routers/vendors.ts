/**
 * Vendors tRPC router.
 *
 * `merge` is the sharpest ownership case in the payments layer: it takes
 * TWO client-supplied vendor ids and deletes one of them. All the
 * enforcement lives in `VendorRepository.merge` itself (it verifies both
 * ids belong to `userId` before any write — see its own doc comment for
 * why), but that check is only real if `userId` is `ctx.userId` and the
 * call is wrapped in a transaction, which is this router's job.
 *
 * `update` / `delete` (SC-83) are the other two id-taking writes, and both
 * re-verify ownership inside `VendorRepository` for the same reason `merge`
 * does. They also make the two refusals this feature has *nameable*: a
 * rename onto an existing name is a CONFLICT rather than a silent merge, and
 * a delete with payments behind it is a CONFLICT carrying the count rather
 * than a `payments_vendor_id_fkey` violation.
 *
 * `create` / `addAlias` are the only write paths that don't already exist
 * elsewhere — every payment needs a `vendorId`, and manual entry (the
 * only input path now that detection was dropped) has no other way to
 * produce one. Both derive `userId` from `ctx.userId`; `create`'s input
 * schema has no `userId` field at all, and `addAlias` re-verifies
 * ownership of the client-supplied `vendorId` before writing, same
 * precedent as `get`.
 */

import type { Vendor, VendorAlias } from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import {
  VendorHasPaymentsError,
  VendorNameConflictError,
  VendorNotFoundError,
  VendorRepository,
} from '@scani/domain/repositories';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

function serializeVendor(vendor: Vendor) {
  return {
    ...vendor,
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  };
}

/**
 * The window "how much do I pay them" is answered over.
 *
 * Twelve months, because an annual bill has to appear in it at least once —
 * a six-month window would report €0 for a vendor billed every January for
 * half of every year, which reads as "I pay them nothing".
 */
const SPEND_WINDOW_MONTHS = 12;

/** How many settlements the detail view shows per vendor. */
const RECENT_SETTLEMENTS_PER_VENDOR = 5;

function spendWindowStart(now: Date, months: number): string {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())
  );
  return start.toISOString().slice(0, 10);
}

function serializeAlias(alias: VendorAlias) {
  return {
    ...alias,
    createdAt: alias.createdAt.toISOString(),
  };
}

export const vendorsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await Container.get(VendorRepository).findByUser(ctx.userId);
    return rows.map(serializeVendor);
  }),

  /**
   * `VendorRepository` has no `findByIdAndUser` (unlike
   * `PaymentRepository`) — ownership is checked here instead, and, same
   * precedent as everywhere else in this feature, "belongs to someone
   * else" and "doesn't exist" both surface as a plain NOT_FOUND so a
   * caller can't use this to probe for another user's vendor ids.
   */
  get: protectedProcedure
    .input(strictInput(z.object({ vendorId: z.string().uuid() })))
    .query(async ({ ctx, input }) => {
      const vendor = await Container.get(VendorRepository).findById(input.vendorId);
      if (!vendor || vendor.userId !== ctx.userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
      }
      return serializeVendor(vendor);
    }),

  /**
   * Existing vendors whose name resembles `name`, best first. Read-only, and
   * the picker's answer to "is this a near-duplicate?" BEFORE the user commits
   * to creating one — `create` itself silently reuses only the confident band,
   * so everything below it has to be a question somebody is actually asked.
   */
  similar: protectedProcedure
    .input(strictInput(z.object({ name: z.string().trim().min(1).max(200) })))
    .query(async ({ ctx, input }) => {
      const candidates = await Container.get(VendorRepository).findCandidates(
        ctx.userId,
        input.name
      );
      return candidates.map((candidate) => ({
        vendor: serializeVendor(candidate.vendor),
        score: candidate.score,
        autoReuse: candidate.autoReuse,
      }));
    }),

  /**
   * What has actually been settled with every vendor — the historical half
   * of "how much do I pay them".
   *
   * Two aggregate queries for the whole list, not one per vendor: the vendor
   * list shows a figure on every row and opens a peek on tap, so a per-vendor
   * call would be N+1 against the surface that consumes it.
   *
   * Both halves stay per-currency and per-direction. Converting to a base
   * currency is the client's job (it holds the rates the rest of the app
   * converts with), and a paid figure that had quietly absorbed income would
   * be wrong in a way no label can rescue.
   */
  spend: protectedProcedure.query(async ({ ctx }) => {
    const vendorRepository = Container.get(VendorRepository);
    const windowStart = spendWindowStart(new Date(), SPEND_WINDOW_MONTHS);

    const [totals, recent] = await Promise.all([
      vendorRepository.settledSpendByUser(ctx.userId, windowStart),
      vendorRepository.recentSettledByUser(ctx.userId, RECENT_SETTLEMENTS_PER_VENDOR),
    ]);

    return { windowStart, windowMonths: SPEND_WINDOW_MONTHS, totals, recent };
  }),

  /**
   * Get-or-create by name, scoped to the caller. Returning the existing
   * row rather than surfacing the `vendors_user_normalized_unique`
   * constraint violation matches `VendorRepository.findByAlias`'s own
   * precedent — "AWS" typed twice from a picker's inline "create new"
   * affordance should resolve to one vendor, not require the caller to
   * pre-check for a duplicate.
   *
   * `resolve` widens that from "the same string twice" to "the same company
   * twice": typing "Hetzner Online" when "Hetzner Online GmbH" exists lands on
   * the existing row. It stops well short of guessing — anything below
   * `VENDOR_MATCH_AUTO_THRESHOLD` creates the new vendor the caller asked for,
   * having already been offered the candidate by `similar`.
   */
  create: protectedProcedure
    .input(
      strictInput(
        z.object({
          displayName: z.string().trim().min(1).max(200),
          category: z.string().trim().max(100).nullable().optional(),
          website: z.string().trim().max(500).nullable().optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const vendorRepository = Container.get(VendorRepository);
      const existing = await vendorRepository.resolve(ctx.userId, input.displayName);
      if (existing) return serializeVendor(existing.vendor);

      const vendor = await vendorRepository.createForUser(ctx.userId, input);
      return serializeVendor(vendor);
    }),

  /**
   * Change what a person chose about a vendor. Everything derived —
   * `normalizedName`, and `matchKey` through it — is recomputed by
   * `updateForUser`; aliases are untouched.
   *
   * A rename onto a name the user already has is a CONFLICT, never an
   * implicit merge (see `VendorNameConflictError`). The message names the
   * other vendor, because "that name is taken" with the taker unnamed is a
   * refusal the reader cannot act on — and `merge` is the action it should
   * send them to.
   */
  update: protectedProcedure
    .input(
      strictInput(
        z.object({
          vendorId: z.string().uuid(),
          displayName: z.string().trim().min(1).max(200).optional(),
          category: z.string().trim().max(100).nullable().optional(),
          website: z.string().trim().max(500).nullable().optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { vendorId, ...patch } = input;
      try {
        const vendor = await Container.get(VendorRepository).updateForUser(
          ctx.userId,
          vendorId,
          patch
        );
        return serializeVendor(vendor);
      } catch (error) {
        if (error instanceof VendorNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
        }
        if (error instanceof VendorNameConflictError) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `You already have a vendor called "${error.conflictingDisplayName}". Rename this one to something else, or merge the two.`,
          });
        }
        throw error;
      }
    }),

  /**
   * What `delete` would do — the same role `mergePreview` plays for merge,
   * and read at the same moment: when the confirmation opens, never as part
   * of `list`.
   */
  deletePreview: protectedProcedure
    .input(strictInput(z.object({ vendorId: z.string().uuid() })))
    .query(async ({ ctx, input }) => {
      try {
        return await Container.get(VendorRepository).deleteImpact(ctx.userId, input.vendorId);
      } catch (error) {
        if (error instanceof VendorNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
        }
        throw error;
      }
    }),

  /**
   * Remove a vendor nothing depends on.
   *
   * Refused with a count while payments still point at it — the payments
   * are the history, and no wording makes destroying them a side effect of
   * removing a name. The message says the number and says what to do
   * instead, because a refusal the reader cannot act on is a dead end.
   */
  delete: protectedProcedure
    .input(strictInput(z.object({ vendorId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      try {
        // Transactional for the reason `deleteForUser` documents: the count
        // it refuses on and the delete it performs are two statements.
        const impact = await withTransaction(
          (tx) => Container.get(VendorRepository).deleteForUser(ctx.userId, input.vendorId, tx),
          { name: 'vendors.delete' }
        );
        return impact;
      } catch (error) {
        if (error instanceof VendorNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
        }
        if (error instanceof VendorHasPaymentsError) {
          const count = error.paymentCount;
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This vendor still has ${count} payment${count === 1 ? '' : 's'}. Delete or move ${count === 1 ? 'it' : 'them'} first, or merge this vendor into another one.`,
          });
        }
        throw error;
      }
    }),

  addAlias: protectedProcedure
    .input(
      strictInput(
        z.object({
          vendorId: z.string().uuid(),
          rawName: z.string().trim().min(1).max(255),
          source: z.string().trim().max(100).optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const vendorRepository = Container.get(VendorRepository);
      const vendor = await vendorRepository.findById(input.vendorId);
      if (!vendor || vendor.userId !== ctx.userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
      }
      const alias = await vendorRepository.addAlias(input.vendorId, input.rawName, input.source);
      return serializeAlias(alias);
    }),

  /**
   * What `merge` would move, so a confirmation can name it before the
   * user commits. Read-only and cheap enough to run when a destructive
   * confirm opens; deliberately NOT folded into `list`, which every
   * Money view loads and none of them needs these counts.
   *
   * `mergeImpact` re-verifies ownership of both ids for the same reason
   * `merge` does — a count is a smaller disclosure than a merge, but it
   * is still one.
   */
  mergePreview: protectedProcedure
    .input(
      strictInput(
        z.object({
          intoId: z.string().uuid(),
          fromId: z.string().uuid(),
        })
      )
    )
    .query(async ({ ctx, input }) => {
      if (input.intoId === input.fromId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot merge a vendor into itself',
        });
      }
      try {
        return await Container.get(VendorRepository).mergeImpact(
          ctx.userId,
          input.intoId,
          input.fromId
        );
      } catch {
        // `mergeImpact` throws a message naming both ids when either is
        // not the caller's. Same precedent as `get`: "not yours" and
        // "not there" are one answer, so this cannot be used to probe.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
      }
    }),

  merge: protectedProcedure
    .input(
      strictInput(
        z.object({
          intoId: z.string().uuid(),
          fromId: z.string().uuid(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      if (input.intoId === input.fromId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot merge a vendor into itself',
        });
      }
      await withTransaction(
        (tx) => Container.get(VendorRepository).merge(ctx.userId, input.intoId, input.fromId, tx),
        { name: 'vendors.merge' }
      );
      return { ok: true as const };
    }),
});
