import { IdInputDto } from '@scani/shared';
import { Container } from 'typedi';
import { AccountService } from '../../application/services/AccountService';
import { HoldingService } from '../../application/services/HoldingService';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const accountService = Container.get(AccountService);
const holdingService = Container.get(HoldingService);

export const accountsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const accounts = await accountService.getAccountsByUserId(dbUser.id);
    return accounts;
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    const accountsWithSummary = await accountService.getAccountsByUserIdWithSummary(dbUser.id);
    return accountsWithSummary;
  }),

  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const account = await accountService.getAccountById(dbUser.id, input.id);
    return account ?? null;
  }),

  getHoldings: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const holdingsWithDetails = await holdingService.getHoldingsByAccountIdWithDetails(
      dbUser,
      input.id
    );
    return holdingsWithDetails;
  }),

  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);

    const result = await accountService.deleteAccount(input.id, dbUser.id);

    if (!result) {
      throw new Error('Account not found or could not be deleted');
    }

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'account',
      operationType: 'delete',
      entityId: input.id,
      userId: dbUser.id,
      data: {},
    });

    return {
      success: true,
    };
  }),
});
