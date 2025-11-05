import Decimal from 'decimal.js';
import { Container } from 'typedi';
import {
  AccountService,
  DashboardService,
  HoldingService,
  PricingService,
  UserContextService,
} from '../../backend/src/application/services';
import {
  CreateHoldingsWithDependenciesUseCase,
  DeleteHoldingUseCase,
  ImportWalletAddressUseCase,
  UpdateHoldingUseCase,
} from '../../backend/src/application/use-cases';
import { BlockchainServiceManager } from '../../backend/src/infrastructure/external-services/blockchain';
import {
  AccountTypeRepository,
  HoldingRepository,
  InstitutionRepository,
  InstitutionTypeRepository,
  TokenRepository,
} from '../../backend/src/infrastructure/repositories';
import type { ToolName } from './tools';

/**
 * Tool executor for Telegram bot
 * Executes tools by directly calling backend services with proper user context
 */

export interface ToolExecutionContext {
  userId: string; // Scani user ID
}

export class ToolExecutor {
  constructor(private context: ToolExecutionContext) {}

  // biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamic based on tool definition
  async executeTool(toolName: ToolName, parameters: any): Promise<any> {
    try {
      switch (toolName) {
        case 'getDashboardOverview':
          return await this.getDashboardOverview();

        case 'listAccounts':
          return await this.listAccounts();

        case 'getAccountDetails':
          return await this.getAccountDetails(parameters.accountId);

        case 'deleteAccount':
          return await this.deleteAccount(parameters.accountId);

        case 'listHoldings':
          return await this.listHoldings(parameters.accountId);

        case 'updateHolding':
          return await this.updateHolding(parameters.holdingId, parameters.quantity);

        case 'deleteHolding':
          return await this.deleteHolding(parameters.holdingId);

        case 'searchTokens':
          return await this.searchTokens(parameters.query, parameters.limit);

        case 'getTokenPrice':
          return await this.getTokenPrice(parameters.symbol);

        case 'listInstitutions':
          return await this.listInstitutions(parameters.type);

        case 'importHoldings':
          return await this.importHoldings(parameters.accountId, parameters.holdings);

        case 'listInstitutionTypes':
          return await this.listInstitutionTypes();

        case 'listAccountTypes':
          return await this.listAccountTypes();

        case 'importWallet':
          return await this.importWallet(parameters.address, parameters.displayName);

        case 'listSupportedChains':
          return await this.listSupportedChains();

        case 'getPortfolioByTokens':
          return await this.getPortfolioByTokens();

        case 'getPortfolioByAccounts':
          return await this.getPortfolioByAccounts();

        case 'getPortfolioByInstitutions':
          return await this.getPortfolioByInstitutions();

        case 'getPortfolioByTokenTypes':
          return await this.getPortfolioByTokenTypes();

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      throw error;
    }
  }

  private async getDashboardOverview() {
    const dashboardService = Container.get(DashboardService);
    return await dashboardService.getDashboardOverview(this.context.userId);
  }

  private async listAccounts() {
    const accountService = Container.get(AccountService);
    return await accountService.getAccountsByUserId(this.context.userId);
  }

  private async getAccountDetails(accountId: string) {
    const accountService = Container.get(AccountService);
    return await accountService.getAccountById(this.context.userId, accountId);
  }

  private async deleteAccount(accountId: string) {
    const accountService = Container.get(AccountService);
    return await accountService.deleteAccount(accountId, this.context.userId);
  }

  private async listHoldings(accountId?: string) {
    const holdingService = Container.get(HoldingService);

    // Get user info for holdings query
    const userContextService = Container.get(UserContextService);
    const dbUser = await userContextService.getUserById(this.context.userId);

    if (!dbUser) {
      throw new Error('User not found');
    }

    return await holdingService.getHoldingsByAccountIdWithDetails(dbUser, accountId);
  }

  private async updateHolding(holdingId: string, quantity?: number) {
    const updateHoldingUseCase = Container.get(UpdateHoldingUseCase);

    // biome-ignore lint/suspicious/noExplicitAny: UpdateHoldingInput fields are optional and dynamically built
    const data: any = {};
    if (quantity !== undefined) data.balance = new Decimal(quantity).toString();

    return await updateHoldingUseCase.execute(holdingId, data, this.context.userId);
  }

  private async deleteHolding(holdingId: string) {
    const deleteHoldingUseCase = Container.get(DeleteHoldingUseCase);
    return await deleteHoldingUseCase.execute(holdingId, this.context.userId);
  }

  private async searchTokens(query: string, limit = 10) {
    const tokenRepository = Container.get(TokenRepository);
    // TODO: Implement efficient search in TokenRepository instead of loading all tokens
    // Current implementation loads all tokens into memory which is inefficient for large datasets
    // Recommended: Add a searchTokens(query, limit) method to TokenRepository with database-level filtering
    const allTokens = await tokenRepository.getAllTokens();
    const searchLower = query.toLowerCase();
    return allTokens
      .filter(
        (t) =>
          t.symbol.toLowerCase().includes(searchLower) || t.name.toLowerCase().includes(searchLower)
      )
      .slice(0, limit);
  }

  private async getTokenPrice(symbol: string) {
    const pricingService = Container.get(PricingService);
    // Find token by symbol first
    const tokenRepository = Container.get(TokenRepository);
    const token = await tokenRepository.getTokenBySymbol(symbol);
    if (!token) {
      throw new Error(`Token not found: ${symbol}`);
    }
    const price = await pricingService.getPrice(token.id);
    return { symbol, price: price?.toString() };
  }

  private async listInstitutions(_type?: string) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.getAllInstitutions();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Holdings array type is dynamic
  private async importHoldings(accountId: string, holdings: any[]) {
    const createHoldingsUseCase = Container.get(CreateHoldingsWithDependenciesUseCase);

    // Convert holdings to proper format
    const formattedHoldings = holdings.map((h) => ({
      tokenSymbol: h.tokenSymbol,
      quantity: new Decimal(h.quantity),
      costBasis: h.costBasis ? new Decimal(h.costBasis) : undefined,
    }));

    return await createHoldingsUseCase.execute(
      {
        accountId,
        holdings: formattedHoldings,
      },
      this.context.userId
    );
  }

  private async listInstitutionTypes() {
    const institutionTypeRepository = Container.get(InstitutionTypeRepository);
    return await institutionTypeRepository.getAllInstitutionTypes();
  }

  private async listAccountTypes() {
    const accountTypeRepository = Container.get(AccountTypeRepository);
    return await accountTypeRepository.getAllAccountTypes();
  }

  private async importWallet(address: string, displayName?: string) {
    const importWalletUseCase = Container.get(ImportWalletAddressUseCase);
    return await importWalletUseCase.execute(
      {
        address,
        displayName,
      },
      this.context.userId
    );
  }

  private async listSupportedChains() {
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
  }

  private async getPortfolioByTokens() {
    const holdingRepository = Container.get(HoldingRepository);
    const pricingService = Container.get(PricingService);

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Collect unique token IDs and batch fetch prices
    const uniqueTokenIds = [...new Set(holdingsWithDetails.map(({ token }) => token.id))];
    const pricePromises = uniqueTokenIds.map((tokenId) => pricingService.getPrice(tokenId));
    const prices = await Promise.all(pricePromises);
    const priceMap = new Map(
      uniqueTokenIds.map((tokenId, index) => [tokenId, prices[index] || new Decimal(0)])
    );

    // Group by token
    const tokenMap = new Map<
      string,
      {
        symbol: string;
        name: string;
        balance: Decimal;
        value: Decimal;
        tokenId: string;
      }
    >();

    for (const { holding, token } of holdingsWithDetails) {
      const balance = new Decimal(holding.balance);
      if (balance.lte(0)) continue;

      const price = priceMap.get(token.id) || new Decimal(0);
      const value = balance.mul(price);

      const existing = tokenMap.get(token.symbol);
      if (existing) {
        existing.balance = existing.balance.add(balance);
        existing.value = existing.value.add(value);
      } else {
        tokenMap.set(token.symbol, {
          symbol: token.symbol,
          name: token.name,
          balance,
          value,
          tokenId: token.id,
        });
      }
    }

    // Calculate total value and percentages
    const tokens = Array.from(tokenMap.values());
    const totalValue = tokens.reduce((sum, t) => sum.add(t.value), new Decimal(0));

    return {
      totalValue: totalValue.toString(),
      tokens: tokens
        .map((t) => ({
          symbol: t.symbol,
          name: t.name,
          balance: t.balance.toString(),
          value: t.value.toString(),
          percentage: totalValue.greaterThan(0)
            ? t.value.div(totalValue).mul(100).toFixed(2)
            : '0.00',
        }))
        .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value))),
    };
  }

  private async getPortfolioByAccounts() {
    const holdingRepository = Container.get(HoldingRepository);
    const pricingService = Container.get(PricingService);

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Collect unique token IDs and batch fetch prices
    const uniqueTokenIds = [...new Set(holdingsWithDetails.map(({ token }) => token.id))];
    const pricePromises = uniqueTokenIds.map((tokenId) => pricingService.getPrice(tokenId));
    const prices = await Promise.all(pricePromises);
    const priceMap = new Map(
      uniqueTokenIds.map((tokenId, index) => [tokenId, prices[index] || new Decimal(0)])
    );

    // Group by account
    const accountMap = new Map<
      string,
      {
        accountId: string;
        accountName: string;
        institutionName: string;
        value: Decimal;
      }
    >();

    for (const { holding, token, account, institution } of holdingsWithDetails) {
      const balance = new Decimal(holding.balance);
      if (balance.lte(0)) continue;

      const price = priceMap.get(token.id) || new Decimal(0);
      const value = balance.mul(price);

      const existing = accountMap.get(account.id);
      if (existing) {
        existing.value = existing.value.add(value);
      } else {
        accountMap.set(account.id, {
          accountId: account.id,
          accountName: account.name,
          institutionName: institution.name,
          value,
        });
      }
    }

    // Calculate total value and percentages
    const accounts = Array.from(accountMap.values());
    const totalValue = accounts.reduce((sum, a) => sum.add(a.value), new Decimal(0));

    return {
      totalValue: totalValue.toString(),
      accounts: accounts
        .map((a) => ({
          accountId: a.accountId,
          accountName: a.accountName,
          institutionName: a.institutionName,
          value: a.value.toString(),
          percentage: totalValue.greaterThan(0)
            ? a.value.div(totalValue).mul(100).toFixed(2)
            : '0.00',
        }))
        .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value))),
    };
  }

  private async getPortfolioByInstitutions() {
    const holdingRepository = Container.get(HoldingRepository);
    const pricingService = Container.get(PricingService);

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Collect unique token IDs and batch fetch prices
    const uniqueTokenIds = [...new Set(holdingsWithDetails.map(({ token }) => token.id))];
    const pricePromises = uniqueTokenIds.map((tokenId) => pricingService.getPrice(tokenId));
    const prices = await Promise.all(pricePromises);
    const priceMap = new Map(
      uniqueTokenIds.map((tokenId, index) => [tokenId, prices[index] || new Decimal(0)])
    );

    // Group by institution
    const institutionMap = new Map<
      string,
      {
        institutionId: string;
        institutionName: string;
        value: Decimal;
      }
    >();

    for (const { holding, token, institution } of holdingsWithDetails) {
      const balance = new Decimal(holding.balance);
      if (balance.lte(0)) continue;

      const price = priceMap.get(token.id) || new Decimal(0);
      const value = balance.mul(price);

      const existing = institutionMap.get(institution.id);
      if (existing) {
        existing.value = existing.value.add(value);
      } else {
        institutionMap.set(institution.id, {
          institutionId: institution.id,
          institutionName: institution.name,
          value,
        });
      }
    }

    // Calculate total value and percentages
    const institutions = Array.from(institutionMap.values());
    const totalValue = institutions.reduce((sum, i) => sum.add(i.value), new Decimal(0));

    return {
      totalValue: totalValue.toString(),
      institutions: institutions
        .map((i) => ({
          institutionId: i.institutionId,
          institutionName: i.institutionName,
          value: i.value.toString(),
          percentage: totalValue.greaterThan(0)
            ? i.value.div(totalValue).mul(100).toFixed(2)
            : '0.00',
        }))
        .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value))),
    };
  }

  private async getPortfolioByTokenTypes() {
    const dashboardService = Container.get(DashboardService);

    // Reuse existing dashboard service which already has asset allocation by token type
    const overview = await dashboardService.getDashboardOverview(this.context.userId);

    return {
      totalValue: overview.portfolioValue.totalValue,
      baseCurrency: overview.portfolioValue.baseCurrency,
      tokenTypes: overview.assetAllocation.map((allocation) => ({
        type: allocation.type,
        code: allocation.code,
        value: allocation.value,
        percentage: allocation.percentage,
      })),
    };
  }
}
