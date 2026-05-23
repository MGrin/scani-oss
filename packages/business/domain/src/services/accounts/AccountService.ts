import type { DatabaseTransaction } from '@scani/db';
import type { Account } from '@scani/db/schema';
import type { AccountWihSumaryDTO, CreateAccountInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { AccountTypeRepository } from '../../repositories/EnumRepositories';
import { GroupRepository } from '../../repositories/GroupRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { InstitutionRepository } from '../../repositories/InstitutionRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { BaseService } from '../BaseService';
import {
  PortfolioValuationService,
  sumPortfolioValuesByAccount,
} from '../portfolio/PortfolioValuationService';
import { UserWalletService } from '../users/UserWalletService';

@Service()
export class AccountService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly userWalletService = Container.get(UserWalletService);
  private readonly userRepository = Container.get(UserRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  constructor() {
    super('AccountService');
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

  async getAccountsByUserId(userId: string): Promise<Account[]> {
    try {
      return await this.accountRepository.findByUser(userId);
    } catch (error) {
      throw this.handleError(error, 'getAccountsByUserId');
    }
  }

  /**
   * Accounts for a user, each annotated with `summary.holdingsCount`
   * + `summary.totalValue`.
   *
   * `totalValue` is a LIVE current valuation — one
   * `getUserPortfolioValue` pass for the whole user, with each
   * holding's value bucketed by `accountId`. This keeps account
   * totals consistent with the holdings view (a freshly-imported
   * account shows its real value immediately instead of $0 until the
   * nightly rollup runs). The `portfolio_value_daily` rollup is still
   * used for the historical net-worth chart — only the current total
   * is live.
   */
  async getAccountsByUserIdWithSummary(userId: string): Promise<AccountWihSumaryDTO[]> {
    const [accounts, user] = await Promise.all([
      this.accountRepository.findByUser(userId),
      this.userRepository.findById(userId),
    ]);
    if (accounts.length === 0) return [];

    const accountIds = accounts.map((a) => a.id);
    const [holdings, groupsMap, portfolio] = await Promise.all([
      this.holdingRepository.findByUser(userId),
      this.groupRepository.findGroupsForAccounts(accountIds),
      user?.baseCurrencyId
        ? this.portfolioValuationService.getUserPortfolioValue(userId, user.baseCurrencyId)
        : Promise.resolve(null),
    ]);

    const holdingsCountByAccount = new Map<string, number>();
    for (const holding of holdings) {
      holdingsCountByAccount.set(
        holding.accountId,
        (holdingsCountByAccount.get(holding.accountId) ?? 0) + 1
      );
    }

    const valueByAccount = sumPortfolioValuesByAccount(portfolio);

    return accounts.map((account) => {
      const accountGroups = groupsMap.get(account.id) || [];
      return {
        ...account,
        summary: {
          holdingsCount: holdingsCountByAccount.get(account.id) ?? 0,
          totalValue: (valueByAccount.get(account.id) ?? new Decimal(0)).toString(),
        },
        groups: accountGroups.map((g) => ({ id: g.id, name: g.name, color: g.color })),
      };
    });
  }

  /**
   * Single-account variant. Detail pages call this instead of paying
   * for the full list when they only render one account.
   */
  async getAccountByIdWithSummary(
    userId: string,
    accountId: string
  ): Promise<AccountWihSumaryDTO | null> {
    const [account, user] = await Promise.all([
      this.accountRepository.findById(accountId),
      this.userRepository.findById(userId),
    ]);
    if (!account || account.userId !== userId) return null;

    const [holdings, groupsMap, portfolio] = await Promise.all([
      this.holdingRepository.findByUser(userId),
      this.groupRepository.findGroupsForAccounts([accountId]),
      user?.baseCurrencyId
        ? this.portfolioValuationService.getUserPortfolioValue(userId, user.baseCurrencyId)
        : Promise.resolve(null),
    ]);

    const holdingsCount = holdings.filter((h) => h.accountId === accountId).length;
    const accountGroups = groupsMap.get(accountId) || [];
    const totalValue = sumPortfolioValuesByAccount(portfolio).get(accountId) ?? new Decimal(0);
    return {
      ...account,
      summary: {
        holdingsCount,
        totalValue: totalValue.toString(),
      },
      groups: accountGroups.map((g) => ({ id: g.id, name: g.name, color: g.color })),
    };
  }

  async deleteAccount(accountId: string, _userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting account', { accountId });

      const existing = await this.accountRepository.findById(accountId);
      this.assertExists(existing, `Account with ID ${accountId} not found`);

      // Check if this is a wallet account with user_wallet association.
      //
      // Historically we also checked `metadata.migrated === true` here,
      // but `SyncWalletBalancesUseCase`'s "auto-create account for newly
      // detected chain" block writes metadata WITHOUT that flag. That
      // meant deleting a cron-auto-created wallet account silently
      // skipped the wallet cleanup below, leaving a stale institutionId
      // on the wallet row — and the next sync immediately re-created
      // the account. The only reliable signal of "this is a wallet
      // account" is `userWalletId` being set; `migrated` is a vestigial
      // flag from the pre-user_wallet data migration.
      const metadata = existing.metadata as Record<string, unknown>;
      const userWalletId = metadata?.userWalletId as string | undefined;

      // If account is associated with a user_wallet, remove the institution
      // from the wallet. If that was the last institution on the wallet, we
      // then hard-delete the wallet row entirely so `SyncWalletBalancesUseCase`
      // doesn't later re-detect chains and silently rehydrate the accounts
      // the user just deleted.
      if (userWalletId && existing.institutionId) {
        try {
          const updatedWallet = await this.userWalletService.removeInstitutionFromWallet(
            userWalletId,
            existing.institutionId
          );
          this.logInfo('Removed institution from user wallet', {
            accountId,
            userWalletId,
            institutionId: existing.institutionId,
          });

          const remainingInstitutions =
            (updatedWallet?.institutionIds as string[] | undefined) ?? [];
          if (remainingInstitutions.length === 0) {
            // Last institution for this wallet — the user is fully removing
            // the wallet from the system. Hard-delete so the sync cron has
            // no row to re-detect chains against on its next pass.
            await this.userWalletService.hardDeleteWallet(userWalletId);
            this.logInfo('Hard-deleted user wallet after last account removal', {
              accountId,
              userWalletId,
            });
          }
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
