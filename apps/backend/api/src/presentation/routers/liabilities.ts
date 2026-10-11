import {
  InvalidLiabilityTerms,
  LiabilityAccountNotFound,
  LiabilityTermsOnAssetAccount,
  LiabilityTermsService,
  userToday,
} from '@scani/domain/services';
import { SetLiabilityTermsDto } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const AccountInput = strictInput(z.object({ accountId: z.string().uuid() }));

function toTrpc(error: unknown): never {
  if (error instanceof LiabilityAccountNotFound) {
    throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  if (error instanceof LiabilityTermsOnAssetAccount || error instanceof InvalidLiabilityTerms) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw error;
}

const service = () => Container.get(LiabilityTermsService);

// A read on an asset account has nothing to show, which is not an error: the
// holdings page asks for every single account it is filtered to.
function nullOnAsset(error: unknown): null {
  if (error instanceof LiabilityTermsOnAssetAccount) return null;
  return toTrpc(error);
}

// SC-1640: loan and card terms on a liability account, and the schedule and
// payoff computed from them on read.
export const liabilitiesRouter = router({
  getTerms: protectedProcedure.input(AccountInput).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    return service().get(dbUser.id, input.accountId).catch(nullOnAsset);
  }),

  setTerms: protectedProcedure
    .input(strictInput(SetLiabilityTermsDto.extend({ accountId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const { accountId, ...terms } = input;
      return service()
        .set(dbUser.id, accountId, terms, undefined, userToday(new Date(), dbUser.timezone))
        .catch(toTrpc);
    }),

  getProjection: protectedProcedure.input(AccountInput).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    return service()
      .projection(dbUser.id, input.accountId, userToday(new Date(), dbUser.timezone))
      .catch(nullOnAsset);
  }),
});
