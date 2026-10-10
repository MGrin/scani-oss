/**
 * Households (SC-1647): people who share READ access to accounts each of them
 * chose to share. Nothing here writes another member's rows; every write path
 * elsewhere keeps its own owner filter, so view-only holds by construction.
 */
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import {
  HouseholdAccessService,
  HouseholdError,
  type HouseholdErrorCode,
  HouseholdMembershipService,
  HouseholdViewService,
} from '@scani/domain/services';
import { renderHouseholdInviteEmail, SCANI_BRAND } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { AssetAllocationDimensionDto } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { DEV_FRONTEND_URL } from '../../config/env';
import { USER_BUDGETS } from '../../config/limits';
import { strictInput } from '../lib/strict-input';
import { UserBudget } from '../lib/user-budget';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const logger = createComponentLogger('router:household');

const inviteBudget = new UserBudget({
  namespace: 'rl:household-invite',
  max: USER_BUDGETS.HOUSEHOLD_INVITES_PER_HOUR,
  windowMs: 60 * 60 * 1000,
});

const CODE: Record<HouseholdErrorCode, TRPCError['code']> = {
  'no-household': 'NOT_FOUND',
  'not-a-member': 'NOT_FOUND',
  'invite-invalid': 'NOT_FOUND',
  'not-owner': 'NOT_FOUND',
  'not-admin': 'FORBIDDEN',
  'invite-email-mismatch': 'FORBIDDEN',
  'already-member': 'CONFLICT',
  'admin-must-hand-over': 'CONFLICT',
  'invite-used': 'CONFLICT',
  'invite-revoked': 'CONFLICT',
  'invite-expired': 'CONFLICT',
};

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HouseholdError) {
      throw new TRPCError({ code: CODE[err.code], message: err.message });
    }
    throw err;
  }
}

const memberships = () => Container.get(HouseholdMembershipService);
const views = () => Container.get(HouseholdViewService);

/**
 * The invite link signs the invitee in first, then lands on the accept page.
 * `Auth` honours only `?returnTo=`, so a bare accept URL would drop a
 * signed-out invitee on Home.
 */
function inviteUrl(token: string): string {
  const app = process.env.FRONTEND_URL || DEV_FRONTEND_URL;
  const url = new URL('/auth', app);
  url.searchParams.set('returnTo', `/household/accept?token=${token}`);
  return url.href;
}

export const householdRouter = router({
  mine: protectedProcedure.query(async ({ ctx }) => {
    const household = await Container.get(HouseholdAccessService).membershipOf(ctx.userId);
    if (!household) return { household: null, members: [], invites: [], sharedAccountIds: [] };
    const [members, invites, visible] = await Promise.all([
      memberships().members(ctx.userId),
      household.role === 'admin' ? memberships().pendingInvites(ctx.userId) : Promise.resolve([]),
      Container.get(HouseholdAccessService).visibleAccounts(ctx.userId),
    ]);
    return {
      household,
      members,
      invites,
      sharedAccountIds: visible.filter((v) => v.ownedByViewer).map((v) => v.accountId),
    };
  }),

  create: protectedProcedure
    .input(strictInput(z.object({ name: z.string().trim().min(1).max(60) })))
    .mutation(({ ctx, input }) => run(() => memberships().create(ctx.userId, input.name))),

  setCurrency: protectedProcedure
    .input(strictInput(z.object({ tokenId: z.string().uuid() })))
    .mutation(({ ctx, input }) => run(() => memberships().setCurrency(ctx.userId, input.tokenId))),

  invite: protectedProcedure
    .input(strictInput(z.object({ email: z.string().trim().email().max(254) })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const budget = await inviteBudget.spend(`user:${dbUser.id}`);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many invites; retry in ${budget.retryAfterSec}s`,
        });
      }
      const invite = await run(() => memberships().invite(dbUser.id, input.email));
      const url = inviteUrl(invite.token);
      const email = Container.get(EmailFacade);
      if (!email.canSendCustomMail()) return { url, emailed: false };

      const household = await Container.get(HouseholdAccessService).membershipOf(dbUser.id);
      const brand = { ...SCANI_BRAND, appUrl: process.env.FRONTEND_URL || DEV_FRONTEND_URL };
      try {
        await email.sendBranded({
          to: input.email,
          brand,
          content: renderHouseholdInviteEmail({
            brand,
            url,
            inviterName: dbUser.name || dbUser.email,
            householdName: household?.name ?? '',
            language: dbUser.language,
          }),
        });
        return { url, emailed: true };
      } catch (err) {
        // The invite exists either way; the admin copies the link instead.
        logger.warn({ err, userId: dbUser.id }, 'household invite mail failed');
        return { url, emailed: false };
      }
    }),

  previewInvite: protectedProcedure
    .input(strictInput(z.object({ token: z.string().min(1).max(128) })))
    .query(({ input }) => run(() => memberships().previewInvite(input.token))),

  accept: protectedProcedure
    .input(strictInput(z.object({ token: z.string().min(1).max(128) })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return run(() => memberships().accept(dbUser.id, dbUser.email, input.token));
    }),

  revoke: protectedProcedure
    .input(strictInput(z.object({ inviteId: z.string().uuid() })))
    .mutation(({ ctx, input }) => run(() => memberships().revoke(ctx.userId, input.inviteId))),

  share: protectedProcedure
    .input(strictInput(z.object({ accountId: z.string().uuid() })))
    .mutation(({ ctx, input }) => run(() => memberships().share(ctx.userId, input.accountId))),

  unshare: protectedProcedure
    .input(strictInput(z.object({ accountId: z.string().uuid() })))
    .mutation(({ ctx, input }) => run(() => memberships().unshare(ctx.userId, input.accountId))),

  /** Net worth, allocation and the shared accounts now, in the household currency. */
  view: protectedProcedure
    .input(strictInput(z.object({ dimension: AssetAllocationDimensionDto.exclude(['group']) })))
    .query(({ ctx, input }) => run(() => views().now(ctx.userId, input.dimension))),

  /** Daily net worth from stored rows only; a day without a rate is named, not summed. */
  history: protectedProcedure
    .input(strictInput(z.object({ from: z.coerce.date(), to: z.coerce.date() })))
    .query(({ ctx, input }) => run(() => views().history(ctx.userId, input.from, input.to))),

  leave: protectedProcedure.mutation(({ ctx }) => run(() => memberships().leave(ctx.userId))),

  remove: protectedProcedure
    .input(strictInput(z.object({ userId: z.string().uuid() })))
    .mutation(({ ctx, input }) => run(() => memberships().remove(ctx.userId, input.userId))),

  transferAdmin: protectedProcedure
    .input(strictInput(z.object({ userId: z.string().uuid() })))
    .mutation(({ ctx, input }) => run(() => memberships().transferAdmin(ctx.userId, input.userId))),
});
