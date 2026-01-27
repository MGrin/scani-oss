import type { AccountWihSumaryDTO, CreateAccountInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { Account } from '../domain/entities';
import { AccountRepository } from '../repositories/AccountRepository';
import type { DatabaseTransaction } from '../repositories/BaseRepository';
import { AccountTypeRepository } from '../repositories/EnumRepositories';
import { GroupRepository } from '../repositories/GroupRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { InstitutionRepository } from '../repositories/InstitutionRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { BaseService } from './BaseService';
import { PortfolioValuationService } from './PortfolioValuationService';
import { UserWalletService } from './UserWalletService';

@Service()
export class AccountService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly userWalletService = Container.get(UserWalletService);

  private readonly portfolioService = Container.get(PortfolioValuationService);

  constructor() {
    super('AccountService');
  }

  /**
   * Extract token prices from portfolio value data
   * Calculates price by dividing value by balance for each holding
   * Returns a map of token symbol to price
   * Note: All holdings of the same token should have the same price.
   * We use the first price found for each token symbol.
   */
  private extractPriceMap(portfolioValue: {
    holdings: Array<{
      tokenSymbol: string;
      balance: string;
      value?: string;
    }>;
  }): Map<string, string> {
    const priceMap = new Map<string, string>();
    for (const portfolioHolding of portfolioValue.holdings) {
      const balance = new Decimal(portfolioHolding.balance);
      const value = new Decimal(portfolioHolding.value || '0');
      if (balance.greaterThan(0) && !priceMap.has(portfolioHolding.tokenSymbol)) {
        const price = value.div(balance);
        priceMap.set(portfolioHolding.tokenSymbol, price.toString());
      }
    }
    return priceMap;
  }

  async createAccount(
    data: CreateAccountInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Account> {
    try {
      this.logInfo('Creating account', {
        name: data.name,
        institutionId: data.institutionId,
      });

      this.validateRequiredFields(data, ['institutionId', 'name', 'typeId', 'institutionId']);
      this.validateNonEmptyString(data.name, 'name');

      // Validate institution exists and belongs to user
      const institution = await this.institutionRepository.findById(data.institutionId!, tx);
      this.assertExists(institution, `Institution with ID ${data.institutionId} not found`);

      const account = await this.accountRepository.create(
        {
          name: data.name,
          typeId: data.typeId,
          institutionId: data.institutionId!,
          userId,
          description: data.description || null,
          metadata: (data.metadata as Record<string, unknown>) || {},
          isActive: true,
        },
        tx
      );

      this.logInfo('Account created', { accountId: account.id });
      return account;
    } catch (error) {
      throw this.handleError(error, 'createAccount');
    }
  }

  async getAccountById(
    userId: string,
    accountId: string,
    tx?: DatabaseTransaction
  ): Promise<Account> {
    try {
      const account = await this.accountRepository.findById(accountId, tx);
      this.assertExists(account, `Account with ID ${accountId} not found`);

      if (account.userId !== userId) {
        throw new Error('Access denied to this account');
      }
      return account;
    } catch (error) {
      throw this.handleError(error, 'getAccountById');
    }
  }

  async getAccountsByUserId(
    userId: string,
    options?: { includeRemoved?: boolean }
  ): Promise<Account[]> {
    try {
      const accounts = await this.accountRepository.findByUser(userId);

      // If includeRemoved is false (default), filter out removed wallet accounts
      if (!options?.includeRemoved) {
        return await this.filterOutRemovedWalletAccounts(userId, accounts);
      }

      return accounts;
    } catch (error) {
      throw this.handleError(error, 'getAccountsByUserId');
    }
  }

  /**
   * Filter out wallet accounts whose institutionId is not in their wallet's institutionIds array
   * These are considered "removed" chains for that wallet
   */
  private async filterOutRemovedWalletAccounts(
    userId: string,
    accounts: Account[]
  ): Promise<Account[]> {
    // Get all user wallets to check which institutions are active
    const userWallets = await this.userWalletService.getUserWallets(userId);

    // Build a map of walletId -> Set of active institutionIds
    const walletInstitutionsMap = new Map<string, Set<string>>();
    for (const wallet of userWallets) {
      const institutionIds = (wallet.institutionIds as string[]) || [];
      walletInstitutionsMap.set(wallet.id, new Set(institutionIds));
    }

    return accounts.filter((account) => {
      const metadata = account.metadata as Record<string, unknown> | null;
      const userWalletId = metadata?.userWalletId as string | undefined;

      // If this is not a wallet account, always include it
      if (!userWalletId) {
        return true;
      }

      // If this is a wallet account, check if its institutionId is in the wallet's active institutionIds
      const activeInstitutions = walletInstitutionsMap.get(userWalletId);
      if (!activeInstitutions) {
        // Wallet not found, exclude the account
        return false;
      }

      // Include account only if its institutionId is in the wallet's active institutions
      return account.institutionId ? activeInstitutions.has(account.institutionId) : false;
    });
  }

  async getAccountsByUserIdWithSummary(
    userId: string,
    options?: { includeRemoved?: boolean }
  ): Promise<AccountWihSumaryDTO[]> {
    // Get user's accounts
    const accounts = await this.getAccountsByUserId(userId, options);

    if (accounts.length === 0) {
      return [];
    }

    const holdings = await this.holdingRepository.findByUser(userId);
    // Filter out inactive holdings from calculations
    const activeHoldings = holdings.filter((h) => h.isActive);

    // Get portfolio value for ALL holdings to get prices
    const portfolioValue = await this.portfolioService.getUserPortfolioValue(userId);

    // Fetch groups for all accounts
    const accountIds = accounts.map((a) => a.id);
    const groupsMap = await this.groupRepository.findGroupsForAccounts(accountIds);

    const holdingsByAccount = new Map<string, typeof activeHoldings>();
    for (const holding of activeHoldings) {
      if (!holdingsByAccount.has(holding.accountId)) {
        holdingsByAccount.set(holding.accountId, []);
      }
      holdingsByAccount.get(holding.accountId)!.push(holding);
    }

    // Extract token prices using helper method
    const tokenIds = [...new Set(activeHoldings.map((h) => h.tokenId))];
    const tokens = await this.tokenRepository.findByIds(tokenIds);
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));

    const priceMap = this.extractPriceMap(portfolioValue);

    const accountsWithSummary = accounts.map((account) => {
      const accountHoldings = holdingsByAccount.get(account.id) || [];
      const holdingsCount = accountHoldings.length;

      // Calculate total value across all holdings in this account
      let totalValue = new Decimal(0);
      for (const holding of accountHoldings) {
        const token = tokenMap.get(holding.tokenId);
        if (token) {
          const price = priceMap.get(token.symbol) || '0';
          const balance = new Decimal(holding.balance);
          const holdingValue = balance.mul(new Decimal(price));
          totalValue = totalValue.add(holdingValue);
        }
      }

      // Get groups for this account
      const accountGroups = groupsMap.get(account.id) || [];

      return {
        ...account,
        summary: {
          holdingsCount,
          totalValue: totalValue.toString(),
        },
        groups: accountGroups.map((g) => ({
          id: g.id,
          name: g.name,
          color: g.color,
        })),
      };
    });

    return accountsWithSummary;
  }

  async deleteAccount(accountId: string, _userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting account', { accountId });

      const existing = await this.accountRepository.findById(accountId);
      this.assertExists(existing, `Account with ID ${accountId} not found`);

      // Check if this is a wallet account with user_wallet association
      const metadata = existing.metadata as Record<string, unknown>;
      const userWalletId = metadata?.userWalletId as string | undefined;
      const migrated = metadata?.migrated as boolean | undefined;

      // If account is associated with a user_wallet, remove the institution from the wallet
      if (userWalletId && migrated && existing.institutionId) {
        try {
          await this.userWalletService.removeInstitutionFromWallet(
            userWalletId,
            existing.institutionId
          );
          this.logInfo('Removed institution from user wallet', {
            accountId,
            userWalletId,
            institutionId: existing.institutionId,
          });
        } catch (walletError) {
          // Log error but don't fail the account deletion
          this.logWarning('Failed to update user wallet during account deletion (non-critical)', {
            accountId,
            userWalletId,
            institutionId: existing.institutionId,
            error: walletError instanceof Error ? walletError.message : String(walletError),
          });
        }
      }

      const deleted = await this.accountRepository.delete(accountId);
      this.logInfo('Account deleted', { accountId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteAccount');
    }
  }

  async updateAccount(
    accountId: string,
    data: {
      name?: string;
      typeId?: string;
      institutionId?: string;
      description?: string | null;
    },
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Account> {
    try {
      this.logInfo('Updating account', { accountId, data });

      // Verify account exists and belongs to user
      const existing = await this.accountRepository.findById(accountId, tx);
      this.assertExists(existing, `Account with ID ${accountId} not found`);

      if (existing.userId !== userId) {
        throw new Error('Access denied to this account');
      }

      // Check if this is a synced account (has walletAddress in metadata)
      const metadata = existing.metadata as Record<string, unknown> | null | undefined;
      const isSynced = metadata && typeof metadata === 'object' && 'walletAddress' in metadata;

      // Prevent updating institutionId and typeId for synced accounts
      if (isSynced) {
        if (data.institutionId !== undefined && data.institutionId !== existing.institutionId) {
          throw new Error('Cannot change institution for automatically synced accounts');
        }
        if (data.typeId !== undefined && data.typeId !== existing.typeId) {
          throw new Error('Cannot change account type for automatically synced accounts');
        }
      }

      // Validate institution exists if being updated
      if (data.institutionId !== undefined && data.institutionId !== existing.institutionId) {
        const institution = await this.institutionRepository.findById(data.institutionId, tx);
        this.assertExists(institution, `Institution with ID ${data.institutionId} not found`);
      }

      // Validate account type exists if being updated
      if (data.typeId !== undefined && data.typeId !== existing.typeId) {
        const accountType = await this.accountTypeRepository.findById(data.typeId, tx);
        this.assertExists(accountType, `Account type with ID ${data.typeId} not found`);
      }

      const updated = await this.accountRepository.updateAccount(accountId, data, tx);
      this.logInfo('Account updated', { accountId });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateAccount');
    }
  }

  /**
   * Find all wallet accounts (accounts with walletAddress in metadata)
   */
  async findWalletAccounts(transaction?: DatabaseTransaction): Promise<Account[]> {
    try {
      return await this.accountRepository.findWalletAccounts(transaction);
    } catch (error) {
      throw this.handleError(error, 'findWalletAccounts');
    }
  }

  /**
   * Update account metadata
   */
  async updateAccountMetadata(
    accountId: string,
    metadata: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      await this.accountRepository.updateMetadata(accountId, metadata, transaction);
    } catch (error) {
      throw this.handleError(error, 'updateAccountMetadata');
    }
  }
}
