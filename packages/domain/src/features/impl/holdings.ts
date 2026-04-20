import type { User } from '@scani/db/schema';
import { Container } from 'typedi';
import {
  AccountRepository,
  AccountTypeRepository,
  GroupRepository,
  HoldingApyConfigRepository,
  HoldingRepository,
  TokenRepository,
} from '../../repositories';
import { HoldingService, UserService } from '../../services';
import {
  DeleteHoldingUseCase,
  UpdateHoldingPriceUseCase,
  UpdateHoldingUseCase,
} from '../../use-cases';
import type { UpdateHoldingInput } from '../../use-cases/UpdateHoldingUseCase';
import { executeBulkOperation, type FeatureExecutionContext } from '../context';

/**
 * Holding-centric feature implementations. Extracted from the 1400-LOC
 * `features/index.ts` barrel so the per-feature surface area is reviewable
 * in isolation — this file is ~290 LOC and covers read, CRUD, bulk, APY
 * config, and restore flows.
 */
export const HoldingImplementations = {
  async getWithDetails(context: FeatureExecutionContext, _input: Record<string, never>) {
    const holdingService = Container.get(HoldingService);
    let dbUser = context.dbUser;
    if (!dbUser) {
      const userService = Container.get(UserService);
      dbUser = (await userService.getUserById(context.userId)) || undefined;
    }
    return await holdingService.getHoldingsByAccountIdWithSummary(
      dbUser as User,
      undefined,
      false,
      context.requestCache
    );
  },

  async create(
    context: FeatureExecutionContext,
    input: { accountId: string; tokenId: string; balance: string; lastUpdated?: Date }
  ) {
    const holdingService = Container.get(HoldingService);
    return await holdingService.createHolding(input, context.userId);
  },

  /**
   * Search for holdings by account name and/or token symbol. Helps AI
   * agents find holdings by human-readable names rather than UUIDs.
   */
  async search(
    context: FeatureExecutionContext,
    input: { accountName?: string; tokenSymbol?: string }
  ) {
    const holdingRepository = Container.get(HoldingRepository);
    const holdings = await holdingRepository.findByUserWithFullDetails(context.userId);

    let filtered = holdings;
    if (input.accountName) {
      const accountNameLower = input.accountName.toLowerCase();
      filtered = filtered.filter((h) => h.account.name.toLowerCase().includes(accountNameLower));
    }
    if (input.tokenSymbol) {
      const tokenSymbolLower = input.tokenSymbol.toLowerCase();
      filtered = filtered.filter((h) => h.token.symbol.toLowerCase() === tokenSymbolLower);
    }

    return filtered.map((h) => ({
      id: h.holding.id,
      balance: h.holding.balance,
      tokenSymbol: h.token.symbol,
      tokenName: h.token.name,
      accountName: h.account.name,
      accountId: h.account.id,
      institutionName: h.institution.name,
      lastUpdated: h.holding.lastUpdated,
    }));
  },

  async update(context: FeatureExecutionContext, input: { id: string; data: UpdateHoldingInput }) {
    const useCase = Container.get(UpdateHoldingUseCase);
    return await useCase.execute(input.id, input.data, context.userId, {
      baseCurrencyId: context.dbUser?.baseCurrencyId || undefined,
    });
  },

  async delete(context: FeatureExecutionContext, input: { id: string }) {
    const useCase = Container.get(DeleteHoldingUseCase);
    return await useCase.execute(input.id, context.userId, {
      baseCurrencyId: context.dbUser?.baseCurrencyId || undefined,
    });
  },

  async bulkDelete(context: FeatureExecutionContext, input: { ids: string[] }) {
    const useCase = Container.get(DeleteHoldingUseCase);
    const baseCurrencyId = context.dbUser?.baseCurrencyId || undefined;
    return await executeBulkOperation(input.ids, (id) =>
      useCase.execute(id, context.userId, { baseCurrencyId })
    );
  },

  async updatePrice(context: FeatureExecutionContext, input: { id: string }) {
    const useCase = Container.get(UpdateHoldingPriceUseCase);
    const tokenRepository = Container.get(TokenRepository);
    const baseCurrency = context.dbUser?.baseCurrencyId
      ? (await tokenRepository.findById(context.dbUser.baseCurrencyId))?.symbol || 'USD'
      : 'USD';
    return await useCase.execute(input.id, context.userId, baseCurrency);
  },

  async restore(context: FeatureExecutionContext, input: { id: string }) {
    const holdingService = Container.get(HoldingService);
    const holdingRepository = Container.get(HoldingRepository);
    const holding = await holdingRepository.findById(input.id);
    if (!holding) throw new Error('Holding not found');
    if (holding.userId !== context.userId) {
      throw new Error('Unauthorized: Holding does not belong to user');
    }
    if (!holding.isHidden) throw new Error('Holding is not hidden');
    const updatedHolding = await holdingService.unhideHoldingWithEvent(input.id);
    if (!updatedHolding) throw new Error('Failed to restore holding');
    return updatedHolding;
  },

  async bulkAssignGroups(
    context: FeatureExecutionContext,
    input: { holdingIds: string[]; addedGroupIds: string[]; removedGroupIds: string[] }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);

    const userHoldings = await holdingRepository.findByUserWithFullDetails(context.userId);
    const userHoldingIds = new Set(userHoldings.map((h) => h.holding.id));
    const invalidHoldingIds = input.holdingIds.filter((id) => !userHoldingIds.has(id));
    if (invalidHoldingIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot assign groups to holdings that don't belong to you: ${invalidHoldingIds.join(
          ', '
        )}`
      );
    }

    // Apply the diff from the dialog. Add then remove — the two sets
    // never overlap so order doesn't matter for correctness, but adds-
    // first keeps the DB in a valid intermediate state for any observer.
    if (input.addedGroupIds.length > 0) {
      await groupRepository.bulkAddHoldingGroups(input.holdingIds, input.addedGroupIds);
    }
    if (input.removedGroupIds.length > 0) {
      await groupRepository.bulkRemoveHoldingGroups(input.holdingIds, input.removedGroupIds);
    }

    // Any holdingGroups change can flip derived account membership — an
    // account is "in" G iff all of its holdings are. Recompute the cache.
    const parentAccountIds = await groupRepository.findParentAccountIdsForHoldings(
      input.holdingIds
    );
    if (parentAccountIds.length > 0) {
      await groupRepository.recomputeAccountGroups(parentAccountIds);
    }

    return { success: true, updatedHoldingIds: input.holdingIds };
  },

  async getCommonGroups(context: FeatureExecutionContext, input: { holdingIds: string[] }) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);
    const userHoldings = await holdingRepository.findByUserWithFullDetails(context.userId);
    const userHoldingIds = new Set(userHoldings.map((h) => h.holding.id));
    const invalidHoldingIds = input.holdingIds.filter((id) => !userHoldingIds.has(id));
    if (invalidHoldingIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot access groups for holdings that don't belong to you: ${invalidHoldingIds.join(
          ', '
        )}`
      );
    }

    const allHoldingGroups = await Promise.all(
      input.holdingIds.map((holdingId) => groupRepository.findGroupsByHoldingId(holdingId))
    );
    if (allHoldingGroups.length === 0) return [];
    return allHoldingGroups.reduce(
      (common: (typeof allHoldingGroups)[0], holdingGroups: (typeof allHoldingGroups)[0]) => {
        const holdingGroupIds = new Set(holdingGroups.map((g) => g.id));
        return common.filter((group) => holdingGroupIds.has(group.id));
      }
    );
  },

  async getApyConfig(context: FeatureExecutionContext, input: { holdingId: string }) {
    const holdingRepository = Container.get(HoldingRepository);
    const apyConfigRepository = Container.get(HoldingApyConfigRepository);
    const holding = await holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== context.userId) throw new Error('Holding not found');
    return await apyConfigRepository.findByHoldingId(input.holdingId);
  },

  async upsertApyConfig(
    context: FeatureExecutionContext,
    input: {
      holdingId: string;
      annualRatePct: string;
      payoutFrequency: string;
      payoutDayOfWeek?: number | null;
      payoutDayOfMonth?: number | null;
      payoutMonth?: number | null;
    }
  ) {
    const holdingRepository = Container.get(HoldingRepository);
    const accountRepository = Container.get(AccountRepository);
    const accountTypeRepository = Container.get(AccountTypeRepository);
    const apyConfigRepository = Container.get(HoldingApyConfigRepository);
    const holding = await holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== context.userId) throw new Error('Holding not found');

    const account = await accountRepository.findById(holding.accountId);
    if (!account) throw new Error('Account not found');
    const accountType = await accountTypeRepository.findById(account.typeId);
    if (!accountType || !['checking', 'savings', 'investment'].includes(accountType.code)) {
      throw new Error(
        'APY configuration is only available for checking, savings, and investment accounts'
      );
    }

    return await apyConfigRepository.upsertByHoldingId(input.holdingId, {
      annualRatePct: input.annualRatePct,
      payoutFrequency: input.payoutFrequency,
      payoutDayOfWeek: input.payoutDayOfWeek ?? null,
      payoutDayOfMonth: input.payoutDayOfMonth ?? null,
      payoutMonth: input.payoutMonth ?? null,
    });
  },

  async deleteApyConfig(context: FeatureExecutionContext, input: { holdingId: string }) {
    const holdingRepository = Container.get(HoldingRepository);
    const apyConfigRepository = Container.get(HoldingApyConfigRepository);
    const holding = await holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== context.userId) throw new Error('Holding not found');
    return await apyConfigRepository.deleteByHoldingId(input.holdingId);
  },
};
