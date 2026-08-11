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
import { normalizeVendorName } from '@scani/domain/lib/normalize-vendor-name';
import { VendorRepository } from '@scani/domain/repositories';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

function serializeVendor(vendor: Vendor) {
  return {
    ...vendor,
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  };
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
    .input(z.object({ vendorId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const vendor = await Container.get(VendorRepository).findById(input.vendorId);
      if (!vendor || vendor.userId !== ctx.userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
      }
      return serializeVendor(vendor);
    }),

  /**
   * Get-or-create by name, scoped to the caller. Returning the existing
   * row on a `normalizedName` collision (rather than surfacing the
   * `vendors_user_normalized_unique` constraint violation) matches
   * `VendorRepository.findByAlias`'s own precedent — "AWS" typed twice
   * from a picker's inline "create new" affordance should resolve to one
   * vendor, not require the caller to pre-check for a duplicate.
   */
  create: protectedProcedure
    .input(
      z.object({
        displayName: z.string().trim().min(1).max(200),
        category: z.string().trim().max(100).nullable().optional(),
        website: z.string().trim().max(500).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const vendorRepository = Container.get(VendorRepository);
      const existing = await vendorRepository.findByAlias(ctx.userId, input.displayName);
      if (existing) return serializeVendor(existing);

      const vendor = await vendorRepository.create({
        userId: ctx.userId,
        displayName: input.displayName,
        normalizedName: normalizeVendorName(input.displayName),
        category: input.category ?? null,
        website: input.website ?? null,
      });
      return serializeVendor(vendor);
    }),

  addAlias: protectedProcedure
    .input(
      z.object({
        vendorId: z.string().uuid(),
        rawName: z.string().trim().min(1).max(255),
        source: z.string().trim().max(100).optional(),
      })
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

  merge: protectedProcedure
    .input(
      z.object({
        intoId: z.string().uuid(),
        fromId: z.string().uuid(),
      })
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
