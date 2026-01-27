/**
 * Feature Implementations
 *
 * This module contains the actual implementation logic for all features.
 * These implementations can be called from both tRPC routers and Telegram bot tools.
 */

import { Container } from 'typedi';
import { BlockchainServiceManager } from '../external-services/blockchain';
import {
  AccountRepository,
  AccountTypeRepository,
  GroupRepository,
  HoldingRepository,
  InstitutionRepository,
  InstitutionTypeRepository,
  TokenRepository,
} from '../repositories';
import {
  AccountService,
  DashboardService,
  HoldingService,
  InstitutionService,
  TokenService,
  UserContextService,
  UserService,
} from '../services';
import {
  CreateHoldingsWithDependenciesUseCase,
  DeleteHoldingUseCase,
  GetAssetAllocationUseCase,
  ImportWalletAddressUseCase,
  UpdateHoldingPriceUseCase,
  UpdateHoldingsBatchUseCase,
  UpdateHoldingUseCase,
} from '../use-cases';
import type { UpdateHoldingInput } from '../use-cases/UpdateHoldingUseCase';
import type { FeatureExecutionContext } from './index';

/**
 * Shared utility for bulk operations with consistent error handling
 */
async function executeBulkOperation<T>(
  ids: string[],
  operation: (id: string) => Promise<T>
): Promise<{
  success: boolean;
  deleted: number;
  failed: number;
  total: number;
  deletedIds: string[];
  failedIds: string[];
}> {
  const results = await Promise.allSettled(ids.map(operation));

  const deletedIds: string[] = [];
  const failedIds: string[] = [];

  results.forEach((result, index) => {
    const id = ids[index];
    if (id) {
      if (result.status === 'fulfilled') {
        deletedIds.push(id);
      } else {
        failedIds.push(id);
      }
    }
  });

  return {
    success: failedIds.length === 0,
    deleted: deletedIds.length,
    failed: failedIds.length,
    total: ids.length,
    deletedIds,
    failedIds,
  };
}

/**
 * Dashboard Implementations
 */
export const DashboardImplementations = {
  async getOverview(context: FeatureExecutionContext, _input: Record<string, never>) {
    const dashboardService = Container.get(DashboardService);
    const userBaseCurrencyId = context.dbUser?.baseCurrencyId || undefined;
    return await dashboardService.getDashboardOverview(context.userId, userBaseCurrencyId);
  },

  async getAssetAllocation(
    context: FeatureExecutionContext,
    input: {
      dimension:
        | 'token'
        | 'token_type'
        | 'account'
        | 'account_type'
        | 'institution'
        | 'institution_type'
        | 'group';
    }
  ) {
    const useCase = Container.get(GetAssetAllocationUseCase);
    const userBaseCurrencyId = context.dbUser?.baseCurrencyId || undefined;
    const result = await useCase.execute(context.userId, input.dimension, userBaseCurrencyId);
    return {
      dimension: input.dimension,
      ...result,
    };
  },
};

/**
 * Account Implementations
 */
export const AccountImplementations = {
  async getAll(context: FeatureExecutionContext, _input: Record<string, never>) {
    const accountService = Container.get(AccountService);
    return await accountService.getAccountsByUserId(context.userId);
  },

  async getByUserIdWithSummary(context: FeatureExecutionContext, _input: Record<string, never>) {
    const accountService = Container.get(AccountService);
    return await accountService.getAccountsByUserIdWithSummary(context.userId);
  },

  async getById(context: FeatureExecutionContext, input: { id: string }) {
    const accountService = Container.get(AccountService);
    return await accountService.getAccountById(context.userId, input.id);
  },

  async getHoldings(
    context: FeatureExecutionContext,
    input: { id: string; includeHidden?: boolean }
  ) {
    const holdingService = Container.get(HoldingService);
    // Need to fetch full user object if not provided
    let dbUser = context.dbUser;
    if (!dbUser) {
      const userContextService = Container.get(UserContextService);
      dbUser = (await userContextService.getUserById(context.userId)) || undefined;
    }
    // Type assertion since the function expects a full user object
    return await holdingService.getHoldingsByAccountIdWithDetails(
      // biome-ignore lint/suspicious/noExplicitAny: Type assertion needed for user object compatibility
      dbUser as any,
      input.id,
      input.includeHidden
    );
  },

  async delete(context: FeatureExecutionContext, input: { id: string }) {
    const accountService = Container.get(AccountService);
    const result = await accountService.deleteAccount(input.id, context.userId);
    if (!result) {
      throw new Error('Account not found or could not be deleted');
    }
    return { success: true };
  },

  async update(
    context: FeatureExecutionContext,
    input: {
      id: string;
      data: {
        name?: string;
        typeId?: string;
        institutionId?: string;
        description?: string | null;
      };
    }
  ) {
    const accountService = Container.get(AccountService);
    const result = await accountService.updateAccount(input.id, input.data, context.userId);
    return result;
  },

  async bulkDelete(context: FeatureExecutionContext, input: { ids: string[] }) {
    const accountService = Container.get(AccountService);
    const result = await executeBulkOperation(input.ids, (id) =>
      accountService.deleteAccount(id, context.userId)
    );
    return result;
  },

  async bulkAssignGroups(
    context: FeatureExecutionContext,
    input: { accountIds: string[]; groupIds: string[] }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);

    // Verify all accounts belong to the user
    const userAccounts = await accountRepository.findByUser(context.userId);
    const userAccountIds = new Set(userAccounts.map((a) => a.id));

    const invalidAccountIds = input.accountIds.filter((id) => !userAccountIds.has(id));
    if (invalidAccountIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot assign groups to accounts that don't belong to you: ${invalidAccountIds.join(
          ', '
        )}`
      );
    }

    // Assign groups to each account
    for (const accountId of input.accountIds) {
      await groupRepository.assignAccountGroups(accountId, input.groupIds);
    }

    return {
      success: true,
      updatedAccountIds: input.accountIds,
    };
  },

  async getCommonGroups(context: FeatureExecutionContext, input: { accountIds: string[] }) {
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);

    // Verify all accounts belong to the user
    const userAccounts = await accountRepository.findByUser(context.userId);
    const userAccountIds = new Set(userAccounts.map((a) => a.id));

    const invalidAccountIds = input.accountIds.filter((id) => !userAccountIds.has(id));
    if (invalidAccountIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot access groups for accounts that don't belong to you: ${invalidAccountIds.join(
          ', '
        )}`
      );
    }

    // Get groups for each account
    const allAccountGroups = await Promise.all(
      input.accountIds.map((accountId) => groupRepository.findGroupsByAccountId(accountId))
    );

    // Find common groups (present in all accounts)
    if (allAccountGroups.length === 0) {
      return [];
    }

    const commonGroups = allAccountGroups.reduce(
      (common: (typeof allAccountGroups)[0], accountGroups: (typeof allAccountGroups)[0]) => {
        const accountGroupIds = new Set(accountGroups.map((g) => g.id));
        return common.filter((group) => accountGroupIds.has(group.id));
      }
    );

    return commonGroups;
  },
};

/**
 * Holdings Implementations
 */
export const HoldingImplementations = {
  async getWithDetails(context: FeatureExecutionContext, _input: Record<string, never>) {
    const holdingService = Container.get(HoldingService);
    // Need to fetch full user object if not provided
    let dbUser = context.dbUser;
    if (!dbUser) {
      const userContextService = Container.get(UserContextService);
      dbUser = (await userContextService.getUserById(context.userId)) || undefined;
    }
    // Type assertion since the function expects a full user object
    // biome-ignore lint/suspicious/noExplicitAny: Type assertion needed for user object compatibility
    return await holdingService.getHoldingsByAccountIdWithDetails(dbUser as any);
  },

  /**
   * Search for holdings by account name and/or token symbol
   * This helps AI agents find holdings when they only know human-readable names, not UUIDs
   */
  async search(
    context: FeatureExecutionContext,
    input: {
      accountName?: string;
      tokenSymbol?: string;
    }
  ) {
    const holdingRepository = Container.get(HoldingRepository);

    // Get all holdings with full details for the user
    const holdings = await holdingRepository.findByUserWithCompleteDetails(context.userId);

    // Filter by account name if provided (case-insensitive partial match)
    let filtered = holdings;
    if (input.accountName) {
      const accountNameLower = input.accountName.toLowerCase();
      filtered = filtered.filter((h) => h.account.name.toLowerCase().includes(accountNameLower));
    }

    // Filter by token symbol if provided (case-insensitive exact match)
    if (input.tokenSymbol) {
      const tokenSymbolLower = input.tokenSymbol.toLowerCase();
      filtered = filtered.filter((h) => h.token.symbol.toLowerCase() === tokenSymbolLower);
    }

    // Return holding IDs and key information
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
    const result = await useCase.execute(input.id, input.data, context.userId);
    return result;
  },

  async delete(context: FeatureExecutionContext, input: { id: string }) {
    const useCase = Container.get(DeleteHoldingUseCase);
    const result = await useCase.execute(input.id, context.userId);
    return result;
  },

  async bulkDelete(context: FeatureExecutionContext, input: { ids: string[] }) {
    const useCase = Container.get(DeleteHoldingUseCase);
    const result = await executeBulkOperation(input.ids, (id) =>
      useCase.execute(id, context.userId)
    );
    return result;
  },

  async updatePrice(context: FeatureExecutionContext, input: { id: string }) {
    const useCase = Container.get(UpdateHoldingPriceUseCase);
    const tokenRepository = Container.get(TokenRepository);

    // Get user's base currency
    const baseCurrency = context.dbUser?.baseCurrencyId
      ? (await tokenRepository.findById(context.dbUser.baseCurrencyId))?.symbol || 'USD'
      : 'USD';

    return await useCase.execute(input.id, context.userId, baseCurrency);
  },

  async restore(context: FeatureExecutionContext, input: { id: string }) {
    const holdingRepository = Container.get(HoldingRepository);

    // Fetch the holding to verify ownership and that it's hidden
    // Pass includeHidden=true since we're specifically looking for hidden holdings
    const holding = await holdingRepository.findById(input.id, undefined, true);
    if (!holding) {
      throw new Error('Holding not found');
    }

    if (holding.userId !== context.userId) {
      throw new Error('Unauthorized: Holding does not belong to user');
    }

    if (!holding.isHidden) {
      throw new Error('Holding is not hidden');
    }

    // Restore the holding by setting isHidden to false
    const updatedHolding = await holdingRepository.update(input.id, { isHidden: false });
    if (!updatedHolding) {
      throw new Error('Failed to restore holding');
    }

    return updatedHolding;
  },

  async bulkAssignGroups(
    context: FeatureExecutionContext,
    input: { holdingIds: string[]; groupIds: string[] }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);

    // Verify all holdings belong to the user
    const userHoldings = await holdingRepository.findByUserWithCompleteDetails(context.userId);
    const userHoldingIds = new Set(userHoldings.map((h) => h.holding.id));

    const invalidHoldingIds = input.holdingIds.filter((id) => !userHoldingIds.has(id));
    if (invalidHoldingIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot assign groups to holdings that don't belong to you: ${invalidHoldingIds.join(
          ', '
        )}`
      );
    }

    // Assign groups to each holding
    for (const holdingId of input.holdingIds) {
      await groupRepository.assignHoldingGroups(holdingId, input.groupIds);
    }

    return {
      success: true,
      updatedHoldingIds: input.holdingIds,
    };
  },

  async getCommonGroups(context: FeatureExecutionContext, input: { holdingIds: string[] }) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);

    // Verify all holdings belong to the user
    const userHoldings = await holdingRepository.findByUserWithCompleteDetails(context.userId);
    const userHoldingIds = new Set(userHoldings.map((h) => h.holding.id));

    const invalidHoldingIds = input.holdingIds.filter((id) => !userHoldingIds.has(id));
    if (invalidHoldingIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot access groups for holdings that don't belong to you: ${invalidHoldingIds.join(
          ', '
        )}`
      );
    }

    // Get groups for each holding
    const allHoldingGroups = await Promise.all(
      input.holdingIds.map((holdingId) => groupRepository.findGroupsByHoldingId(holdingId))
    );

    // Find common groups (present in all holdings)
    if (allHoldingGroups.length === 0) {
      return [];
    }

    const commonGroups = allHoldingGroups.reduce(
      (common: (typeof allHoldingGroups)[0], holdingGroups: (typeof allHoldingGroups)[0]) => {
        const holdingGroupIds = new Set(holdingGroups.map((g) => g.id));
        return common.filter((group) => holdingGroupIds.has(group.id));
      }
    );

    return commonGroups;
  },
};

/**
 * Institution Implementations
 */
export const InstitutionImplementations = {
  async getAll(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findAll();
  },

  async getByUserId(context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findByUserId(context.userId);
  },

  async getByUserIdWithSummary(context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionService = Container.get(InstitutionService);
    return await institutionService.getInstitutionsByUserIdWithSummary(context.userId);
  },

  async getById(_context: FeatureExecutionContext, input: { id: string }) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findById(input.id);
  },
};

/**
 * Token Implementations
 */
export const TokenImplementations = {
  async getAll(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const tokenRepository = Container.get(TokenRepository);
    return await tokenRepository.findAll();
  },

  async search(_context: FeatureExecutionContext, input: { query: string; limit?: number }) {
    const tokenRepository = Container.get(TokenRepository);
    const allTokens = await tokenRepository.findAll();
    const searchLower = input.query.toLowerCase();
    return allTokens
      .filter(
        (t) =>
          t.symbol.toLowerCase().includes(searchLower) || t.name.toLowerCase().includes(searchLower)
      )
      .slice(0, input.limit || 10);
  },
};

/**
 * Wallet Implementations
 */
export const WalletImplementations = {
  async getSupportedChains(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const blockchainService = Container.get(BlockchainServiceManager);
    const chains = blockchainService.getAllSupportedChains();
    return chains.map((chain) => ({
      chainId: chain.chainId,
      name: chain.name,
      type: chain.type,
      nativeSymbol: chain.nativeSymbol,
      nativeName: chain.nativeName,
      isActive: chain.isActive,
    }));
  },

  async importAddress(
    context: FeatureExecutionContext,
    input: { address: string; displayName?: string }
  ) {
    const useCase = Container.get(ImportWalletAddressUseCase);
    return await useCase.execute(input, context.userId);
  },

  async detectChains(_context: FeatureExecutionContext, input: { address: string }) {
    const blockchainService = Container.get(BlockchainServiceManager);
    const detectedChains = await blockchainService.detectWalletChains(input.address);

    const chains = blockchainService.getAllSupportedChains();
    const detectedChainDetails = chains
      .filter((chain) => detectedChains.includes(chain.chainId))
      .map((chain) => ({
        chainId: chain.chainId,
        name: chain.name,
        type: chain.type,
        nativeSymbol: chain.nativeSymbol,
      }));

    return {
      address: input.address,
      chainsDetected: detectedChainDetails,
      totalChains: detectedChainDetails.length,
    };
  },
};

/**
 * Batch Operation Implementations
 */
export const BatchOperationImplementations = {
  async createHoldingsWithDependencies(
    context: FeatureExecutionContext,
    input: {
      accountId?: string;
      holdings: Array<{ tokenId: string; balance: string }>;
    }
  ) {
    const useCase = Container.get(CreateHoldingsWithDependenciesUseCase);
    // Need full user object
    let dbUser = context.dbUser;
    if (!dbUser) {
      const userService = Container.get(UserService);
      const user = await userService.getUserById(context.userId);
      if (!user) throw new Error('User not found');
      dbUser = user;
    }
    // Type assertion since the function expects a full user object
    // biome-ignore lint/suspicious/noExplicitAny: Type assertion needed for user object compatibility
    const result = await useCase.execute(input, dbUser as any);
    return result;
  },

  async updateHoldingsBatch(
    context: FeatureExecutionContext,
    input: {
      holdings: Array<{ id: string; balance: string; lastUpdated?: string }>;
    }
  ) {
    const useCase = Container.get(UpdateHoldingsBatchUseCase);
    // Convert string dates to Date objects if provided
    const formattedHoldings = input.holdings.map((h) => ({
      ...h,
      lastUpdated: h.lastUpdated ? new Date(h.lastUpdated) : undefined,
    }));
    const result = await useCase.execute({ holdings: formattedHoldings }, context.userId);
    return result;
  },
};

/**
 * Settings Implementations
 */
export const SettingsImplementations = {
  async getCurrent(context: FeatureExecutionContext, _input: Record<string, never>) {
    const userContextService = Container.get(UserContextService);
    return await userContextService.getUserById(context.userId);
  },

  async updateCurrent(
    context: FeatureExecutionContext,
    input: {
      name?: string;
      avatar?: string | null;
      baseCurrencyId?: string | null;
    }
  ) {
    const userService = Container.get(UserService);
    const result = await userService.updateUser(context.userId, input);
    return result;
  },

  async getSupportedCurrencies(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const tokenService = Container.get(TokenService);
    const fiatTokens = await tokenService.getTokensByType('fiat');
    return fiatTokens.map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
    }));
  },

  async getBaseCurrency(context: FeatureExecutionContext, _input: Record<string, never>) {
    const userContextService = Container.get(UserContextService);
    const tokenService = Container.get(TokenService);

    const dbUser = await userContextService.getUserById(context.userId);
    if (!dbUser || !dbUser.baseCurrencyId) {
      return null;
    }

    const baseCurrency = await tokenService.getTokenById(dbUser.baseCurrencyId);
    if (!baseCurrency) {
      return null;
    }

    return {
      id: baseCurrency.id,
      symbol: baseCurrency.symbol,
      name: baseCurrency.name,
    };
  },
};

/**
 * Screenshot Implementations
 */
export const ScreenshotImplementations = {
  async parseScreenshots(
    _context: FeatureExecutionContext,
    _input: {
      files: Array<{ filename: string; data: string; contentType?: string }>;
      provider?: 'openai' | 'perplexity' | 'deepseek';
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      minConfidence?: number;
      accountId?: string;
    }
  ) {
    // Screenshot parsing is a complex feature that requires AI services
    // Implementation would go here but is currently handled directly in the tRPC router
    // This placeholder ensures the feature interface is complete
    throw new Error('Screenshot parsing must be called through the tRPC router for now');
  },
};

/**
 * Type Implementations (Account Types, Institution Types)
 */
export const TypeImplementations = {
  async getAccountTypes(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const accountTypeRepository = Container.get(AccountTypeRepository);
    return await accountTypeRepository.findAll();
  },

  async getInstitutionTypes(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionTypeRepository = Container.get(InstitutionTypeRepository);
    return await institutionTypeRepository.findAll();
  },
};

/**
 * Group Implementations
 */
export const GroupImplementations = {
  async getAll(context: FeatureExecutionContext, _input: Record<string, never>) {
    const groupRepository = Container.get(GroupRepository);
    return await groupRepository.findByUser(context.userId);
  },

  async getAllWithCounts(context: FeatureExecutionContext, _input: Record<string, never>) {
    const groupRepository = Container.get(GroupRepository);
    return await groupRepository.findByUserWithCounts(context.userId);
  },

  async getById(context: FeatureExecutionContext, input: { id: string }) {
    const groupRepository = Container.get(GroupRepository);
    const group = await groupRepository.findById(input.id);

    // Verify ownership
    if (group && group.userId !== context.userId) {
      throw new Error('Unauthorized access to group');
    }

    return group;
  },

  async create(
    context: FeatureExecutionContext,
    input: {
      name: string;
      color: string;
      description?: string | null;
      displayOrder?: number;
    }
  ) {
    const groupRepository = Container.get(GroupRepository);

    try {
      return await groupRepository.create({
        userId: context.userId,
        name: input.name,
        color: input.color,
        description: input.description || null,
        displayOrder: input.displayOrder || 0,
        isActive: true,
      });
    } catch (error) {
      // Check if this is a unique constraint violation on (userId, name)
      // PostgreSQL error code 23505 = unique_violation
      if (
        error instanceof Error &&
        // biome-ignore lint/suspicious/noExplicitAny: Database error type is not strictly typed
        ((error as any).code === '23505' ||
          error.message.includes('unique constraint') ||
          error.message.includes('duplicate key') ||
          error.message.includes('uniqueUserGroupName'))
      ) {
        throw new Error(`A group with the name "${input.name}" already exists`);
      }
      // Re-throw other errors
      throw error;
    }
  },

  async update(
    context: FeatureExecutionContext,
    input: {
      id: string;
      data: {
        name?: string;
        color?: string;
        description?: string | null;
        displayOrder?: number;
        isActive?: boolean;
      };
    }
  ) {
    const groupRepository = Container.get(GroupRepository);

    // Verify ownership
    const group = await groupRepository.findById(input.id);
    if (!group || group.userId !== context.userId) {
      throw new Error('Unauthorized access to group');
    }

    return await groupRepository.update(input.id, input.data);
  },

  async delete(context: FeatureExecutionContext, input: { id: string }) {
    const groupRepository = Container.get(GroupRepository);

    // Verify ownership
    const group = await groupRepository.findById(input.id);
    if (!group || group.userId !== context.userId) {
      throw new Error('Unauthorized access to group');
    }

    // Delete the group (cascade will handle junction table cleanup)
    await groupRepository.delete(input.id);

    return { success: true };
  },

  async bulkDelete(context: FeatureExecutionContext, input: { ids: string[] }) {
    return executeBulkOperation(input.ids, async (id) => {
      await GroupImplementations.delete(context, { id });
    });
  },

  async assignHoldingGroups(
    context: FeatureExecutionContext,
    input: {
      holdingId: string;
      groupIds: string[];
    }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);

    // Verify holding ownership
    const holding = await holdingRepository.findById(input.holdingId);
    if (!holding || holding.userId !== context.userId) {
      throw new Error('Unauthorized access to holding');
    }

    // Verify all groups belong to the user
    if (input.groupIds.length > 0) {
      const groups = await Promise.all(input.groupIds.map((id) => groupRepository.findById(id)));

      if (groups.some((g) => !g || g.userId !== context.userId)) {
        throw new Error('Unauthorized access to one or more groups');
      }
    }

    await groupRepository.assignHoldingGroups(input.holdingId, input.groupIds);

    return { success: true };
  },

  async assignAccountGroups(
    context: FeatureExecutionContext,
    input: {
      accountId: string;
      groupIds: string[];
    }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);

    // Verify account ownership
    const account = await accountRepository.findById(input.accountId);
    if (!account || account.userId !== context.userId) {
      throw new Error('Unauthorized access to account');
    }

    // Verify all groups belong to the user
    if (input.groupIds.length > 0) {
      const groups = await Promise.all(input.groupIds.map((id) => groupRepository.findById(id)));

      if (groups.some((g) => !g || g.userId !== context.userId)) {
        throw new Error('Unauthorized access to one or more groups');
      }
    }

    await groupRepository.assignAccountGroups(input.accountId, input.groupIds);

    return { success: true };
  },

  async getHoldingGroups(context: FeatureExecutionContext, input: { holdingId: string }) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);

    // Verify holding ownership
    const holding = await holdingRepository.findById(input.holdingId);
    if (!holding || holding.userId !== context.userId) {
      throw new Error('Unauthorized access to holding');
    }

    return await groupRepository.findGroupsByHoldingId(input.holdingId);
  },

  async getAccountGroups(context: FeatureExecutionContext, input: { accountId: string }) {
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);

    // Verify account ownership
    const account = await accountRepository.findById(input.accountId);
    if (!account || account.userId !== context.userId) {
      throw new Error('Unauthorized access to account');
    }

    return await groupRepository.findGroupsByAccountId(input.accountId);
  },
};
