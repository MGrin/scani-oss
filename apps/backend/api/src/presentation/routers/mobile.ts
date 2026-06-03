import type { User } from '@scani/db';
import { GroupRepository } from '@scani/domain/repositories';
import { AccountService, HoldingQueryService, VaultService } from '@scani/domain/services';
import { Container } from 'typedi';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { MobileAccount, MobileGroup, MobileHolding, MobileVault } from '../mobile-dtos';
import { protectedProcedure, router } from '../trpc';

export const mobileRouter = router({
  accounts: protectedProcedure.output(z.array(MobileAccount)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const rows = await Container.get(AccountService).getAccountsByUserIdWithSummary(dbUser.id);
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      typeId: a.typeId,
      institutionId: a.institutionId ?? null,
      totalValue: a.summary.totalValue,
    }));
  }),

  holdings: protectedProcedure.output(z.array(MobileHolding)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const { holdings } = await Container.get(HoldingQueryService).getHoldingsByAccountIdWithSummary(
      dbUser as User,
      undefined,
      false,
      ctx.requestCache
    );
    return holdings.map((h) => ({
      id: h.id,
      accountId: h.account.id,
      symbol: h.token.symbol,
      name: h.token.name,
      amount: String(h.amount),
      value: h.value !== null ? String(h.value) : null,
    }));
  }),

  groups: protectedProcedure.output(z.array(MobileGroup)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const rows = await Container.get(GroupRepository).findByUser(dbUser.id);
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      description: g.description ?? null,
    }));
  }),

  vaults: protectedProcedure.output(z.array(MobileVault)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const rows = await Container.get(VaultService).getVaultsForUser(dbUser.id);
    return rows.map((v) => ({
      id: v.id,
      name: v.name,
      targetAmount: String(v.targetAmount),
      currentAmount: String(v.currentAmount),
      currencyId: v.currencyId,
      color: v.color,
      iconName: v.iconName ?? null,
      description: v.description ?? null,
    }));
  }),
});
