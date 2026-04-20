/**
 * Feature Implementations
 *
 * This module contains the actual implementation logic for all features.
 * These implementations can be called from both tRPC routers and Telegram bot tools.
 */

import type { User } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { IntegrationManager } from '@scani/integrations';
import { createComponentLogger } from '@scani/logging';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  AccountRepository,
  AccountTypeRepository,
  GroupRepository,
  HoldingRepository,
  InstitutionBlockchainMappingRepository,
  InstitutionRepository,
  InstitutionTypeRepository,
  TokenRepository,
  VaultRepository,
} from '../repositories';
import {
  AccountService,
  DashboardService,
  HoldingService,
  InstitutionService,
  TokenService,
  UserService,
  VaultService,
} from '../services';
import { AssetAllocationService } from '../services/AssetAllocationService';
import {
  CreateHoldingsWithDependenciesUseCase,
  ImportWalletAddressUseCase,
  UpdateHoldingsBatchUseCase,
} from '../use-cases';

// Shared primitives moved to `./context.ts` so per-feature splits can
// pull them without importing this 1400-LOC barrel. New `*Implementations`
// objects should live in their own file next to this one and re-export
// from this index; see `./context.ts` for the DDD-friendly pattern.
export { executeBulkOperation, type FeatureExecutionContext } from './context';

import type { FeatureExecutionContext } from './context';
import { executeBulkOperation } from './context';

/**
 * Dashboard Implementations
 */
export const DashboardImplementations = {
  async getOverview(context: FeatureExecutionContext, _input: Record<string, never>) {
    const dashboardService = Container.get(DashboardService);
    const userBaseCurrencyId = context.dbUser?.baseCurrencyId || undefined;
    return await dashboardService.getDashboardOverview(
      context.userId,
      userBaseCurrencyId,
      context.requestCache
    );
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
    const useCase = Container.get(AssetAllocationService);
    const userBaseCurrencyId = context.dbUser?.baseCurrencyId || undefined;
    const result = await useCase.execute(
      context.userId,
      input.dimension,
      userBaseCurrencyId,
      context.requestCache
    );
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
    return await accountService.getAccountsByUserIdWithSummary(
      context.userId,
      context.requestCache
    );
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
      const userService = Container.get(UserService);
      dbUser = (await userService.getUserById(context.userId)) || undefined;
    }
    // Type assertion since the function expects a full user object
    // Use new method that returns summary with pre-calculated totals
    return await holdingService.getHoldingsByAccountIdWithSummary(
      dbUser as User,
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
    input: { accountIds: string[]; addedGroupIds: string[]; removedGroupIds: string[] }
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

    // Under the current group model, account membership is derived from
    // holding membership: an account is "in" group G iff every visible
    // holding of the account is in G. So an account-level group add
    // cascades down to every visible holding of each account, and a
    // removal is the symmetric operation. The accountGroups table is a
    // cache and gets rebuilt after the holding-layer writes.
    const holdingIds = await groupRepository.findVisibleHoldingIdsForAccounts(input.accountIds);

    if (holdingIds.length > 0) {
      if (input.addedGroupIds.length > 0) {
        await groupRepository.bulkAddHoldingGroups(holdingIds, input.addedGroupIds);
      }
      if (input.removedGroupIds.length > 0) {
        await groupRepository.bulkRemoveHoldingGroups(holdingIds, input.removedGroupIds);
      }
    }

    // Rebuild the accountGroups cache for every account we touched. We
    // always recompute — even if the account had zero holdings and
    // therefore nothing actually changed at the holding layer — because
    // the cache may be holding stale rows from before this model was
    // introduced.
    await groupRepository.recomputeAccountGroups(input.accountIds);

    return {
      success: true,
      updatedAccountIds: input.accountIds,
    };
  },

  async create(
    context: FeatureExecutionContext,
    input: {
      institutionId?: string;
      name: string;
      typeId: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    const accountService = Container.get(AccountService);
    return await accountService.createAccount(input, context.userId);
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
// Holdings implementations extracted to ./impl/holdings.ts (~290 LOC).
// Re-exported so call sites keep their existing `HoldingImplementations` import.
export { HoldingImplementations } from './impl/holdings';

/**
 * Institution Implementations
 */
export const InstitutionImplementations = {
  async getAll(_context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findAll();
  },

  async create(
    context: FeatureExecutionContext,
    input: {
      name: string;
      typeId: string;
      description?: string;
      website?: string;
      logoUrl?: string;
    }
  ) {
    const institutionService = Container.get(InstitutionService);
    return await institutionService.createInstitution(input, context.userId);
  },

  async getByUserId(context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findByUserId(context.userId);
  },

  async getByUserIdWithSummary(context: FeatureExecutionContext, _input: Record<string, never>) {
    const institutionService = Container.get(InstitutionService);
    return await institutionService.getInstitutionsByUserIdWithSummary(
      context.userId,
      context.requestCache
    );
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
    const integrationManager = Container.get(IntegrationManager);
    const chains = integrationManager.getAllSupportedChains();
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
    input: { address: string; displayName?: string; detectedInstitutionIds?: string[] }
  ) {
    const useCase = Container.get(ImportWalletAddressUseCase);
    return await useCase.execute(input, context.userId);
  },

  async detectChains(_context: FeatureExecutionContext, input: { address: string }) {
    const integrationManager = Container.get(IntegrationManager);
    const mappingRepository = Container.get(InstitutionBlockchainMappingRepository);

    // Run chain detection and ENS resolution in parallel
    const [detectedChains, ensName] = await Promise.all([
      integrationManager.detectWalletChains(input.address),
      integrationManager.resolveEnsName(input.address),
    ]);

    const chains = integrationManager.getAllSupportedChains();
    const detectedChainDetails = chains
      .filter((chain) => detectedChains.includes(chain.chainId))
      .map((chain) => ({
        chainId: chain.chainId,
        name: chain.name,
        type: chain.type,
        nativeSymbol: chain.nativeSymbol,
      }));

    // Look up institution IDs for detected chains so the import step can
    // skip redundant re-detection (avoids rate-limit hits on public RPCs).
    const institutionIds: string[] = [];
    for (const chain of detectedChainDetails) {
      const mapping = await mappingRepository.findByChainId(String(chain.chainId));
      if (mapping) {
        institutionIds.push(mapping.institutionId);
      }
    }

    return {
      address: input.address,
      ensName: ensName ?? undefined,
      chainsDetected: detectedChainDetails,
      totalChains: detectedChainDetails.length,
      institutionIds,
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
      institution?: {
        name: string;
        typeId: string;
        website?: string;
      };
      account?: {
        name: string;
        typeId: string;
        institutionId?: string;
      };
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
    const result = await useCase.execute(input, dbUser as User);
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
    const userService = Container.get(UserService);
    return await userService.getUserById(context.userId);
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

  async deleteAllData(context: FeatureExecutionContext, _input: Record<string, never>) {
    const logger = createComponentLogger('settings:delete-all-data');
    logger.warn({ userId: context.userId }, 'User requested deletion of all data');

    await withTransaction(
      async (tx) => {
        // Delete in FK-safe order. Junction tables (holdingGroups, accountGroups,
        // vaultHoldings) cascade automatically from their parent deletes.
        const holdingsDel = await tx
          .delete(schema.holdings)
          .where(eq(schema.holdings.userId, context.userId))
          .returning({ id: schema.holdings.id });

        const accountsDel = await tx
          .delete(schema.accounts)
          .where(eq(schema.accounts.userId, context.userId))
          .returning({ id: schema.accounts.id });

        const vaultsDel = await tx
          .delete(schema.vaults)
          .where(eq(schema.vaults.userId, context.userId))
          .returning({ id: schema.vaults.id });

        const groupsDel = await tx
          .delete(schema.groups)
          .where(eq(schema.groups.userId, context.userId))
          .returning({ id: schema.groups.id });

        const walletsDel = await tx
          .delete(schema.userWallets)
          .where(eq(schema.userWallets.userId, context.userId))
          .returning({ id: schema.userWallets.id });

        const credentialsDel = await tx
          .delete(schema.userIntegrationCredentials)
          .where(eq(schema.userIntegrationCredentials.userId, context.userId))
          .returning({ id: schema.userIntegrationCredentials.id });

        // Wipe the user's job history too. `users(id)` has ON DELETE CASCADE
        // over user_jobs, but this flow deletes *user data* without removing
        // the user row — so the cascade never fires and stale job rows would
        // linger in the /jobs page. Note: the running `user-data-delete` job
        // deletes its own row here; the worker's post-handler markCompleted
        // then becomes a no-op UPDATE (zero rows affected), which is fine.
        const jobsDel = await tx
          .delete(schema.userJobs)
          .where(eq(schema.userJobs.userId, context.userId))
          .returning({ jobId: schema.userJobs.jobId });

        logger.info(
          {
            userId: context.userId,
            holdings: holdingsDel.length,
            accounts: accountsDel.length,
            vaults: vaultsDel.length,
            groups: groupsDel.length,
            wallets: walletsDel.length,
            credentials: credentialsDel.length,
            jobs: jobsDel.length,
          },
          'All user data deleted successfully'
        );
      },
      { name: 'deleteAllUserData', timeout: 30000 }
    );

    return { success: true };
  },

  async getBaseCurrency(context: FeatureExecutionContext, _input: Record<string, never>) {
    const userService = Container.get(UserService);
    const tokenService = Container.get(TokenService);

    const dbUser = await userService.getUserById(context.userId);
    if (!dbUser?.baseCurrencyId) {
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
 * Portfolio History Implementations
 */

// Group implementations extracted to ./impl/groups.ts (~220 LOC).
// Re-exported so call sites keep their existing `GroupImplementations` import.
export { GroupImplementations } from './impl/groups';

/**
 * Vault Implementations
 */
export const VaultImplementations = {
  async getAll(context: FeatureExecutionContext, _input: Record<string, never>) {
    const vaultService = Container.get(VaultService);
    return await vaultService.getVaultsForUser(context.userId);
  },

  async getById(context: FeatureExecutionContext, input: { id: string }) {
    const vaultService = Container.get(VaultService);
    const vault = await vaultService.getVaultWithProgress(input.id);

    if (!vault || vault.userId !== context.userId) {
      throw new Error('Vault not found');
    }

    return vault;
  },

  async getByHoldingId(context: FeatureExecutionContext, input: { holdingId: string }) {
    const vaultRepository = Container.get(VaultRepository);
    const tokenRepository = Container.get(TokenRepository);

    const vaultRefs = await vaultRepository.findVaultsByHoldingId(input.holdingId);

    // Filter to only vaults owned by this user and enrich with currency symbol
    const results = [];
    for (const ref of vaultRefs) {
      if (ref.vault.userId !== context.userId) continue;
      const currency = await tokenRepository.findById(ref.vault.currencyId);
      results.push({
        id: ref.vault.id,
        name: ref.vault.name,
        color: ref.vault.color,
        percentage: ref.percentage,
        currencySymbol: currency?.symbol || '?',
        targetAmount: ref.vault.targetAmount,
        currentAmount: ref.vault.currentAmount,
      });
    }

    return results;
  },

  async create(
    context: FeatureExecutionContext,
    input: {
      name: string;
      targetAmount: string;
      currencyId: string;
      color: string;
      iconName?: string | null;
      description?: string | null;
    }
  ) {
    const vaultRepository = Container.get(VaultRepository);

    try {
      return await vaultRepository.create({
        userId: context.userId,
        name: input.name,
        targetAmount: input.targetAmount,
        currencyId: input.currencyId,
        color: input.color,
        iconName: input.iconName || null,
        description: input.description || null,
        currentAmount: '0',
        isActive: true,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ((error as unknown as { code: string }).code === '23505' ||
          error.message.includes('unique constraint') ||
          error.message.includes('duplicate key') ||
          error.message.includes('uniqueUserVaultName'))
      ) {
        throw new Error(`A vault with the name "${input.name}" already exists`);
      }
      throw error;
    }
  },

  async update(
    context: FeatureExecutionContext,
    input: {
      id: string;
      data: {
        name?: string;
        targetAmount?: string;
        currencyId?: string;
        color?: string;
        iconName?: string | null;
        description?: string | null;
        isActive?: boolean;
      };
    }
  ) {
    const vaultRepository = Container.get(VaultRepository);
    const vaultService = Container.get(VaultService);

    // Verify ownership
    const vault = await vaultRepository.findById(input.id);
    if (!vault || vault.userId !== context.userId) {
      throw new Error('Vault not found');
    }

    const updated = await vaultRepository.update(input.id, {
      ...input.data,
      updatedAt: new Date(),
    });

    // If currency changed, recalculate vault amount
    if (input.data.currencyId && input.data.currencyId !== vault.currencyId) {
      await vaultService.recalculateVaultAmount(input.id);
    }

    return updated;
  },

  async delete(context: FeatureExecutionContext, input: { id: string }) {
    const vaultRepository = Container.get(VaultRepository);

    // Verify ownership
    const vault = await vaultRepository.findById(input.id);
    if (!vault || vault.userId !== context.userId) {
      throw new Error('Vault not found');
    }

    await vaultRepository.delete(input.id);
    return { success: true };
  },

  async bulkDelete(context: FeatureExecutionContext, input: { ids: string[] }) {
    return executeBulkOperation(input.ids, async (id) => {
      await VaultImplementations.delete(context, { id });
    });
  },

  async attachHolding(
    context: FeatureExecutionContext,
    input: { vaultId: string; holdingId: string; percentage: number }
  ) {
    const vaultRepository = Container.get(VaultRepository);
    const holdingRepository = Container.get(HoldingRepository);
    const vaultService = Container.get(VaultService);

    // Verify vault ownership
    const vault = await vaultRepository.findById(input.vaultId);
    if (!vault || vault.userId !== context.userId) {
      throw new Error('Vault not found');
    }

    // Verify holding ownership
    const holding = await holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== context.userId) {
      throw new Error('Holding not found');
    }

    const result = await vaultRepository.attachHolding(
      input.vaultId,
      input.holdingId,
      input.percentage
    );

    // Recalculate vault amount after attaching
    await vaultService.recalculateVaultAmount(input.vaultId);

    return result;
  },

  async detachHolding(
    context: FeatureExecutionContext,
    input: { vaultId: string; holdingId: string }
  ) {
    const vaultRepository = Container.get(VaultRepository);
    const vaultService = Container.get(VaultService);

    // Verify vault ownership
    const vault = await vaultRepository.findById(input.vaultId);
    if (!vault || vault.userId !== context.userId) {
      throw new Error('Vault not found');
    }

    await vaultRepository.detachHolding(input.vaultId, input.holdingId);

    // Recalculate vault amount after detaching
    await vaultService.recalculateVaultAmount(input.vaultId);

    return { success: true };
  },

  async updateHoldingPercentage(
    context: FeatureExecutionContext,
    input: { vaultId: string; holdingId: string; percentage: number }
  ) {
    const vaultRepository = Container.get(VaultRepository);
    const vaultService = Container.get(VaultService);

    // Verify vault ownership
    const vault = await vaultRepository.findById(input.vaultId);
    if (!vault || vault.userId !== context.userId) {
      throw new Error('Vault not found');
    }

    const result = await vaultRepository.updateHoldingPercentage(
      input.vaultId,
      input.holdingId,
      input.percentage
    );

    if (!result) {
      throw new Error('Vault holding not found');
    }

    // Recalculate vault amount after percentage change
    await vaultService.recalculateVaultAmount(input.vaultId);

    return result;
  },
};
