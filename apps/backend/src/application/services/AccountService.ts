import type { AccountWihSumaryDTO, CreateAccountInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { Account } from '../../domain/entities';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import type { DatabaseTransaction } from '../../infrastructure/repositories/BaseRepository';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { BaseService } from './BaseService';
import { PortfolioValuationService } from './PortfolioValuationService';

@Service()
export class AccountService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);

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

  async getAccountsByUserId(userId: string): Promise<Account[]> {
    try {
      return await this.accountRepository.findByUser(userId);
    } catch (error) {
      throw this.handleError(error, 'getAccountsByUserId');
    }
  }

  async getAccountsByUserIdWithSummary(userId: string): Promise<AccountWihSumaryDTO[]> {
    // Get user's accounts
    const accounts = await this.getAccountsByUserId(userId);

    if (accounts.length === 0) {
      return [];
    }

    const holdings = await this.holdingRepository.findByUser(userId);

    // Get portfolio value for ALL holdings to get prices
    const portfolioValue = await this.portfolioService.getUserPortfolioValue(userId);

    const holdingsByAccount = new Map<string, typeof holdings>();
    for (const holding of holdings) {
      if (!holdingsByAccount.has(holding.accountId)) {
        holdingsByAccount.set(holding.accountId, []);
      }
      holdingsByAccount.get(holding.accountId)!.push(holding);
    }

    // Extract token prices using helper method
    const tokenIds = [...new Set(holdings.map((h) => h.tokenId))];
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

      return {
        ...account,
        summary: {
          holdingsCount,
          totalValue: totalValue.toString(),
        },
      };
    });

    return accountsWithSummary;
  }

  async deleteAccount(accountId: string, _userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting account', { accountId });

      const existing = await this.accountRepository.findById(accountId);
      this.assertExists(existing, `Account with ID ${accountId} not found`);

      const deleted = await this.accountRepository.delete(accountId);
      this.logInfo('Account deleted', { accountId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteAccount');
    }
  }
}
