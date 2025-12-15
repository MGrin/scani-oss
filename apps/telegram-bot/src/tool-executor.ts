import {
  AccountImplementations,
  DashboardImplementations,
} from '@scani/core/features/implementations';
import {
  AccountTypeRepository,
  HoldingRepository,
  InstitutionRepository,
  InstitutionTypeRepository,
  TokenPriceRepository,
  TokenRepository,
} from '@scani/core/repositories';
import {
  AccountService,
  HoldingService,
  InstitutionService,
  PricingService,
  TokenService,
  UserContextService,
  UserService,
} from '@scani/core/services';
import {
  CreateHoldingsWithDependenciesUseCase,
  DeleteHoldingUseCase,
  GetAssetAllocationUseCase,
  ImportWalletAddressUseCase,
  UpdateHoldingPriceUseCase,
  UpdateHoldingsBatchUseCase,
  UpdateHoldingUseCase,
} from '@scani/core/use-cases';
import type { UpdateHoldingInput } from '@scani/core/use-cases/UpdateHoldingUseCase';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { ChartGenerator } from './chart-generator';
import type { ToolName } from './tools';

/**
 * Tool executor for Telegram bot
 * Executes tools by directly calling backend services with proper user context
 */

export interface ToolExecutionContext {
  userId: string; // Scani user ID
}

// Singleton ChartGenerator instance shared across all ToolExecutor instances
// This avoids creating a new ChartJSNodeCanvas for each tool execution
let sharedChartGenerator: ChartGenerator | null = null;

function getChartGenerator(): ChartGenerator {
  if (!sharedChartGenerator) {
    sharedChartGenerator = new ChartGenerator();
  }
  return sharedChartGenerator;
}

export class ToolExecutor {
  private chartGenerator: ChartGenerator;

  constructor(private context: ToolExecutionContext) {
    // Reuse shared ChartGenerator instance across all tool executors
    this.chartGenerator = getChartGenerator();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Tool parameters are dynamic based on tool definition
  async executeTool(toolName: ToolName, parameters: any): Promise<any> {
    try {
      switch (toolName) {
        // Dashboard features
        case 'getDashboardOverview':
        case 'dashboardGetOverview':
          return await this.getDashboardOverview();

        case 'getDashboardAssetAllocation':
        case 'dashboardGetAssetAllocation':
          return await this.getDashboardAssetAllocation(parameters.dimension);

        // Account features
        case 'getAccountsAll':
        case 'listAccounts':
        case 'accountsGetAll':
          return await this.listAccounts();

        case 'getAccountsByUserIdWithSummary':
        case 'accountsGetByUserIdWithSummary':
          return await this.getAccountsByUserIdWithSummary();

        case 'getAccountsById':
        case 'getAccountDetails':
        case 'accountsGetById':
          return await this.getAccountDetails(parameters.id || parameters.accountId);

        case 'getAccountsHoldings':
        case 'accountsGetHoldings':
          return await this.getAccountHoldings(parameters.id);

        case 'deleteAccountsDelete':
        case 'deleteAccount':
        case 'accountsDelete':
          return await this.deleteAccount(parameters.id || parameters.accountId);

        case 'getAccountTypesAll':
        case 'listAccountTypes':
        case 'accountTypesGetAll':
          return await this.listAccountTypes();

        // Holdings features
        case 'getHoldingsWithDetails':
        case 'listHoldings':
        case 'holdingsGetWithDetails':
          return await this.listHoldings(parameters.accountId);

        case 'searchHoldingsSearch':
        case 'searchHoldings':
        case 'holdingsSearch':
          return await this.searchHoldings(parameters.accountName, parameters.tokenSymbol);

        case 'updateHoldingsUpdate':
        case 'updateHolding':
        case 'holdingsUpdate':
          return await this.updateHolding(
            parameters.id || parameters.holdingId,
            parameters.data || { balance: parameters.quantity?.toString() }
          );

        case 'deleteHoldingsDelete':
        case 'deleteHolding':
        case 'holdingsDelete':
          return await this.deleteHolding(parameters.id || parameters.holdingId);

        case 'updateHoldingsUpdatePrice':
        case 'holdingsUpdatePrice':
        case 'updateHoldingsPrice':
          return await this.updateHoldingPrice(parameters.id);

        // Institution features
        case 'getInstitutionsAll':
        case 'listInstitutions':
        case 'institutionsGetAll':
          return await this.listInstitutions(parameters.type);

        case 'getInstitutionsByUserId':
        case 'institutionsGetByUserId':
          return await this.getInstitutionsByUserId();

        case 'getInstitutionsByUserIdWithSummary':
        case 'institutionsGetByUserIdWithSummary':
          return await this.getInstitutionsByUserIdWithSummary();

        case 'getInstitutionsById':
        case 'institutionsGetById':
          return await this.getInstitutionDetails(parameters.id);

        case 'getInstitutionTypesAll':
        case 'listInstitutionTypes':
        case 'institutionTypesGetAll':
          return await this.listInstitutionTypes();

        // Token features
        case 'getTokensAll':
        case 'tokensGetAll':
          return await this.getAllTokens();

        case 'searchTokens':
        case 'tokensSearch':
        case 'searchTokensSearch':
          return await this.searchTokens(parameters.query, parameters.limit);

        // Wallet features
        case 'getWalletSupportedChains':
        case 'listSupportedChains':
        case 'walletGetSupportedChains':
          return await this.listSupportedChains();

        case 'importWalletAddress':
        case 'importWallet':
        case 'walletImportAddress':
          return await this.importWallet(parameters.address, parameters.displayName);

        case 'detectWalletChains':
        case 'walletDetectChains':
          return await this.detectWalletChains(parameters.address);

        // Batch operations
        case 'createBatchOperationsHoldingsWithDependencies':
        case 'importHoldings':
        case 'batchOperationsCreateHoldingsWithDependencies':
          return await this.importHoldings(parameters.accountId, parameters.holdings);

        case 'updateBatchOperationsHoldingsBatch':
        case 'batchOperationsUpdateHoldingsBatch':
          return await this.updateHoldingsBatch(parameters.holdings);

        // Settings features
        case 'getUsersCurrent':
        case 'usersGetCurrent':
          return await this.getCurrentUser();

        case 'updateUsersCurrent':
        case 'usersUpdateCurrent':
          return await this.updateCurrentUser(parameters);

        case 'getUsersSupportedCurrencies':
        case 'usersGetSupportedCurrencies':
          return await this.getSupportedCurrencies();

        case 'getUsersBaseCurrency':
        case 'usersGetBaseCurrency':
          return await this.getBaseCurrency();

        // Portfolio analysis (special tools)
        case 'getPortfolioByTokens':
          return await this.getPortfolioByTokens();

        case 'getPortfolioByAccounts':
          return await this.getPortfolioByAccounts();

        case 'getPortfolioByInstitutions':
          return await this.getPortfolioByInstitutions();

        case 'getPortfolioByTokenTypes':
          return await this.getPortfolioByTokenTypes();

        case 'generatePortfolioChart':
          return await this.generatePortfolioChart(parameters.chartType, parameters.dataType);

        case 'get24hPriceChanges':
          return await this.get24hPriceChanges(parameters.limit);

        // New analysis tools
        case 'analyzePortfolioDiversification':
          return await this.analyzePortfolioDiversification();

        case 'compareHoldings':
          return await this.compareHoldings(parameters.tokenSymbols);

        case 'suggestRebalancing':
          return await this.suggestRebalancing();

        case 'calculatePortfolioMetrics':
          return await this.calculatePortfolioMetrics();

        case 'findLargestHoldings':
          return await this.findLargestHoldings(parameters.limit);

        case 'findSmallestHoldings':
          return await this.findSmallestHoldings(parameters.limit);

        case 'searchTokensByType':
          return await this.searchTokensByType(parameters.tokenType, parameters.limit);

        case 'getAccountSummary':
          return await this.getAccountSummary(parameters.accountId);

        case 'explainHolding':
          return await this.explainHolding(parameters.tokenSymbol);

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      throw error;
    }
  }

  private async getDashboardOverview() {
    return await DashboardImplementations.getOverview({ userId: this.context.userId }, {});
  }

  private async listAccounts() {
    return await AccountImplementations.getAll({ userId: this.context.userId }, {});
  }

  private async getAccountDetails(accountId: string) {
    return await AccountImplementations.getById({ userId: this.context.userId }, { id: accountId });
  }

  private async deleteAccount(accountId: string) {
    return await AccountImplementations.delete({ userId: this.context.userId }, { id: accountId });
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

  private async searchHoldings(accountName?: string, tokenSymbol?: string) {
    const holdingRepository = Container.get(HoldingRepository);

    // Get all holdings with full details for the user
    const holdings = await holdingRepository.findByUserWithCompleteDetails(this.context.userId);

    // Filter by account name if provided (case-insensitive partial match)
    let filtered = holdings;
    if (accountName) {
      const accountNameLower = accountName.toLowerCase();
      filtered = filtered.filter((h) => h.account.name.toLowerCase().includes(accountNameLower));
    }

    // Filter by token symbol if provided (case-insensitive exact match)
    if (tokenSymbol) {
      const tokenSymbolLower = tokenSymbol.toLowerCase();
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
  }

  // biome-ignore lint/suspicious/noExplicitAny: Holdings update data structure varies
  private async updateHolding(holdingId: string, data: any) {
    const updateHoldingUseCase = Container.get(UpdateHoldingUseCase);

    // Handle both old and new parameter formats
    const updateData: UpdateHoldingInput = {};
    if (data) {
      if (data.balance) {
        updateData.balance = data.balance;
      }
      if (data.lastUpdated) {
        updateData.lastUpdated =
          data.lastUpdated instanceof Date ? data.lastUpdated : new Date(data.lastUpdated);
      }
    }

    return await updateHoldingUseCase.execute(holdingId, updateData, this.context.userId);
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
    const allTokens = await tokenRepository.findAll();
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
    const token = await tokenRepository.findBySymbol(symbol);
    if (!token) {
      throw new Error(`Token not found: ${symbol}`);
    }
    const price = await pricingService.getTokenPrice(token, 'USD', new Date());
    return { symbol, price: price?.toString() };
  }

  private async listInstitutions(_type?: string) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findAll();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Holdings array type is dynamic
  private async importHoldings(accountId: string, holdings: any[]) {
    const createHoldingsUseCase = Container.get(CreateHoldingsWithDependenciesUseCase);
    const tokenRepository = Container.get(TokenRepository);
    const userService = Container.get(UserService);

    // Get the full user object
    const user = await userService.getUserById(this.context.userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Convert holdings to proper format - resolve token symbols to IDs
    const formattedHoldings = await Promise.all(
      holdings.map(async (h) => {
        const token = await tokenRepository.findBySymbol(h.tokenSymbol);
        if (!token) {
          throw new Error(`Token not found: ${h.tokenSymbol}`);
        }
        return {
          tokenId: token.id,
          balance: new Decimal(h.quantity).toString(),
        };
      })
    );

    return await createHoldingsUseCase.execute(
      {
        accountId,
        holdings: formattedHoldings,
      },
      user
    );
  }

  private async listInstitutionTypes() {
    const institutionTypeRepository = Container.get(InstitutionTypeRepository);
    return await institutionTypeRepository.findAll();
  }

  private async listAccountTypes() {
    const accountTypeRepository = Container.get(AccountTypeRepository);
    return await accountTypeRepository.findAll();
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
    // Note: This feature needs to be reimplemented with IntegrationManager
    // For now, return empty array as chains are now managed via institution_blockchain_mappings
    return [];
  }

  // New methods for additional features

  private async getDashboardAssetAllocation(
    dimension:
      | 'token'
      | 'token_type'
      | 'account'
      | 'account_type'
      | 'institution'
      | 'institution_type'
  ) {
    const userContextService = Container.get(UserContextService);
    const dbUser = await userContextService.getUserById(this.context.userId);

    if (!dbUser) {
      throw new Error('User not found');
    }

    const userBaseCurrencyId = dbUser.baseCurrencyId || undefined;

    // Use GetAssetAllocationUseCase
    const useCase = Container.get(GetAssetAllocationUseCase);

    const result = await useCase.execute(this.context.userId, dimension, userBaseCurrencyId);

    return {
      dimension,
      ...result,
    };
  }

  private async getAccountsByUserIdWithSummary() {
    const accountService = Container.get(AccountService);
    return await accountService.getAccountsByUserIdWithSummary(this.context.userId);
  }

  private async getAccountHoldings(accountId: string) {
    const holdingService = Container.get(HoldingService);
    const userContextService = Container.get(UserContextService);
    const dbUser = await userContextService.getUserById(this.context.userId);

    if (!dbUser) {
      throw new Error('User not found');
    }

    return await holdingService.getHoldingsByAccountIdWithDetails(dbUser, accountId);
  }

  private async updateHoldingPrice(holdingId: string) {
    const useCase = Container.get(UpdateHoldingPriceUseCase);
    const tokenRepository = Container.get(TokenRepository);
    const userContextService = Container.get(UserContextService);

    const dbUser = await userContextService.getUserById(this.context.userId);
    if (!dbUser) {
      throw new Error('User not found');
    }

    const baseCurrency = dbUser.baseCurrencyId
      ? (await tokenRepository.findById(dbUser.baseCurrencyId))?.symbol || 'USD'
      : 'USD';

    return await useCase.execute(holdingId, this.context.userId, baseCurrency);
  }

  private async getInstitutionsByUserId() {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findByUserId(this.context.userId);
  }

  private async getInstitutionsByUserIdWithSummary() {
    const institutionService = Container.get(InstitutionService);
    return await institutionService.getInstitutionsByUserIdWithSummary(this.context.userId);
  }

  private async getInstitutionDetails(institutionId: string) {
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.findById(institutionId);
  }

  private async getAllTokens() {
    const tokenRepository = Container.get(TokenRepository);
    return await tokenRepository.findAll();
  }

  private async detectWalletChains(address: string) {
    // Note: This feature needs to be reimplemented with IntegrationManager
    // Wallet chain detection is now handled by IntegrationManager during import
    return {
      address,
      chainsDetected: [],
      totalChains: 0,
      note: 'Wallet chain detection is now automatic during wallet import',
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Holdings update data is dynamic
  private async updateHoldingsBatch(holdings: any[]) {
    const useCase = Container.get(UpdateHoldingsBatchUseCase);

    // Convert string dates to Date objects if provided
    const formattedHoldings = holdings.map((h) => ({
      ...h,
      lastUpdated: h.lastUpdated ? new Date(h.lastUpdated) : undefined,
    }));

    return await useCase.execute({ holdings: formattedHoldings }, this.context.userId);
  }

  private async getCurrentUser() {
    const userContextService = Container.get(UserContextService);
    return await userContextService.getUserById(this.context.userId);
  }

  // biome-ignore lint/suspicious/noExplicitAny: User update data is dynamic
  private async updateCurrentUser(data: any) {
    const userService = Container.get(UserService);
    return await userService.updateUser(this.context.userId, data);
  }

  private async getSupportedCurrencies() {
    const tokenService = Container.get(TokenService);
    const fiatTokens = await tokenService.getTokensByType('fiat');

    return fiatTokens.map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
    }));
  }

  private async getBaseCurrency() {
    const userContextService = Container.get(UserContextService);
    const tokenService = Container.get(TokenService);

    const dbUser = await userContextService.getUserById(this.context.userId);
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
  }

  /**
   * Helper method to batch fetch prices for multiple tokens
   * @param holdingsWithDetails Holdings data with complete token information
   * @returns Map of token ID to price (Decimal)
   */
  private async batchFetchPrices(
    holdingsWithDetails: Awaited<ReturnType<HoldingRepository['findByUserWithCompleteDetails']>>
  ): Promise<Map<string, Decimal>> {
    const pricingService = Container.get(PricingService);

    // Collect unique tokens and batch fetch prices
    const uniqueTokens = [...new Set(holdingsWithDetails.map(({ token }) => token))];
    const pricePromises = uniqueTokens.map((token) =>
      pricingService.getTokenPrice(token, 'USD', new Date())
    );
    const prices = await Promise.all(pricePromises);

    return new Map(
      uniqueTokens.map((token, index) => [token.id, new Decimal(prices[index] || '0')])
    );
  }

  private async getPortfolioByTokens() {
    const holdingRepository = Container.get(HoldingRepository);

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Batch fetch prices for all tokens
    const priceMap = await this.batchFetchPrices(holdingsWithDetails);

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

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Batch fetch prices for all tokens
    const priceMap = await this.batchFetchPrices(holdingsWithDetails);

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

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Batch fetch prices for all tokens
    const priceMap = await this.batchFetchPrices(holdingsWithDetails);

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
    const holdingRepository = Container.get(HoldingRepository);
    const userContextService = Container.get(UserContextService);

    // Get user to retrieve base currency
    const dbUser = await userContextService.getUserById(this.context.userId);
    if (!dbUser) {
      throw new Error('User not found');
    }

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    // Batch fetch prices for all tokens
    const priceMap = await this.batchFetchPrices(holdingsWithDetails);

    // Group by token type
    const typeMap = new Map<
      string,
      {
        type: string;
        code: string;
        value: Decimal;
      }
    >();

    for (const { holding, token } of holdingsWithDetails) {
      const balance = new Decimal(holding.balance);
      if (balance.lte(0)) continue;

      const price = priceMap.get(token.id) || new Decimal(0);
      const value = balance.mul(price);

      const existing = typeMap.get(token.typeCode);
      if (existing) {
        existing.value = existing.value.add(value);
      } else {
        typeMap.set(token.typeCode, {
          type: token.typeName,
          code: token.typeCode,
          value,
        });
      }
    }

    // Calculate total value and percentages
    const tokenTypes = Array.from(typeMap.values());
    const totalValue = tokenTypes.reduce((sum, t) => sum.add(t.value), new Decimal(0));

    // Get base currency symbol (default to USD if not set)
    let baseCurrencySymbol = 'USD';
    if (dbUser.baseCurrencyId && holdingsWithDetails.length > 0) {
      // Find the base currency token from holdings if available
      const baseCurrencyToken = holdingsWithDetails.find(
        ({ token }) => token.id === dbUser.baseCurrencyId
      );
      if (baseCurrencyToken) {
        baseCurrencySymbol = baseCurrencyToken.token.symbol;
      }
    }

    return {
      totalValue: totalValue.toString(),
      baseCurrency: baseCurrencySymbol,
      tokenTypes: tokenTypes
        .map((t) => ({
          type: t.type,
          code: t.code,
          value: t.value.toString(),
          percentage: totalValue.greaterThan(0)
            ? t.value.div(totalValue).mul(100).toFixed(2)
            : '0.00',
        }))
        .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value))),
    };
  }

  /**
   * Generate a portfolio chart image
   */
  private async generatePortfolioChart(
    chartType: 'donut' | 'bar',
    dataType: 'tokens' | 'accounts' | 'institutions' | 'tokenTypes'
  ): Promise<string> {
    // Get the data based on dataType
    // biome-ignore lint/suspicious/noExplicitAny: Portfolio data structure varies by dataType
    let data: any;
    let title: string;
    let labels: string[];
    let values: number[];

    switch (dataType) {
      case 'tokens': {
        data = await this.getPortfolioByTokens();
        title = 'Portfolio by Tokens';
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio token data from getPortfolioByTokens is dynamically typed
        labels = data.tokens.slice(0, 10).map((t: any) => `${t.symbol} (${t.percentage}%)`);
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio token data from getPortfolioByTokens is dynamically typed
        values = data.tokens.slice(0, 10).map((t: any) => parseFloat(t.value));
        break;
      }
      case 'accounts': {
        data = await this.getPortfolioByAccounts();
        title = 'Portfolio by Accounts';
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio account data from getPortfolioByAccounts is dynamically typed
        labels = data.accounts.map((a: any) => `${a.accountName} (${a.percentage}%)`);
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio account data from getPortfolioByAccounts is dynamically typed
        values = data.accounts.map((a: any) => parseFloat(a.value));
        break;
      }
      case 'institutions': {
        data = await this.getPortfolioByInstitutions();
        title = 'Portfolio by Institutions';
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio institution data from getPortfolioByInstitutions is dynamically typed
        labels = data.institutions.map((i: any) => `${i.institutionName} (${i.percentage}%)`);
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio institution data from getPortfolioByInstitutions is dynamically typed
        values = data.institutions.map((i: any) => parseFloat(i.value));
        break;
      }
      case 'tokenTypes': {
        data = await this.getPortfolioByTokenTypes();
        title = 'Asset Allocation';
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio token type data from getPortfolioByTokenTypes is dynamically typed
        labels = data.tokenTypes.map((t: any) => `${t.type} (${t.percentage}%)`);
        // biome-ignore lint/suspicious/noExplicitAny: Portfolio token type data from getPortfolioByTokenTypes is dynamically typed
        values = data.tokenTypes.map((t: any) => parseFloat(t.value));
        break;
      }
      default:
        throw new Error(`Unknown data type: ${dataType}`);
    }

    // Generate the chart
    let chartBuffer: Buffer;
    if (chartType === 'donut') {
      chartBuffer = await this.chartGenerator.generateDonutChart({
        labels,
        values,
        title,
      });
    } else {
      chartBuffer = await this.chartGenerator.generateBarChart({
        labels,
        values,
        title,
        valueLabel: `Value (${data.baseCurrency})`,
      });
    }

    // Return special marker format that the bot will recognize
    const base64 = chartBuffer.toString('base64');

    // Format currency symbol based on base currency
    const currencySymbols: Record<string, string> = {
      USD: '$',
      EUR: '€',
      GBP: '£',
      JPY: '¥',
      CNY: '¥',
    };
    const currencySymbol = currencySymbols[data.baseCurrency] || data.baseCurrency;

    const caption = `${title}\nTotal Value: ${currencySymbol}${parseFloat(data.totalValue).toFixed(2)}`;
    return `[CHART:${base64}]\n${caption}`;
  }

  /**
   * Get 24-hour price changes for all tokens in the user's portfolio
   * Returns top movers (both gainers and losers) with percentage and absolute value changes
   */
  private async get24hPriceChanges(limit = 10) {
    const holdingRepository = Container.get(HoldingRepository);
    const tokenRepository = Container.get(TokenRepository);
    const tokenPriceRepository = Container.get(TokenPriceRepository);

    // Get all user holdings with token details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    if (holdingsWithDetails.length === 0) {
      return {
        changes: [],
        message: 'No holdings found in portfolio',
      };
    }

    // Get unique tokens from holdings
    const uniqueTokens = Array.from(
      new Map(holdingsWithDetails.map((h) => [h.token.id, h.token])).values()
    );

    // Find USD base token
    const usdToken = await tokenRepository.findBySymbol('USD');
    if (!usdToken) {
      throw new Error('USD base token not found');
    }

    // Calculate 24 hours ago
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const windowMs = 2 * 60 * 60 * 1000; // 2-hour window for finding historical price

    // Fetch current and 24h-ago prices for all tokens
    const priceChanges = await Promise.all(
      uniqueTokens.map(async (token) => {
        try {
          // Get current price
          const currentPrice = await tokenPriceRepository.findLatestPrice(token.id, usdToken.id);

          // Get price from 24 hours ago
          const historicalPrice = await tokenPriceRepository.findPriceAtTimestamp(
            token.id,
            usdToken.id,
            yesterday,
            windowMs
          );

          if (!currentPrice || !historicalPrice) {
            return null;
          }

          const currentPriceDecimal = new Decimal(currentPrice.price);
          const historicalPriceDecimal = new Decimal(historicalPrice.price);

          // Calculate change
          const priceChange = currentPriceDecimal.minus(historicalPriceDecimal);
          const percentChange = priceChange.div(historicalPriceDecimal).mul(100).toDecimalPlaces(2);

          // Calculate user's holding value and impact
          const userHoldings = holdingsWithDetails.filter((h) => h.token.id === token.id);
          const totalBalance = userHoldings.reduce(
            (sum, h) => sum.add(new Decimal(h.holding.balance)),
            new Decimal(0)
          );
          const valueChange = priceChange.mul(totalBalance);

          return {
            symbol: token.symbol,
            name: token.name,
            currentPrice: currentPriceDecimal.toString(),
            historicalPrice: historicalPriceDecimal.toString(),
            priceChange: priceChange.toString(),
            percentChange: percentChange.toString(),
            userBalance: totalBalance.toString(),
            valueChange: valueChange.toString(),
            currentValue: currentPriceDecimal.mul(totalBalance).toString(),
          };
        } catch (error) {
          console.error(`Error calculating price change for ${token.symbol}:`, error);
          return null;
        }
      })
    );

    // Filter out nulls and sort by absolute percent change
    const validChanges = priceChanges
      .filter((change) => change !== null)
      .sort((a, b) => {
        const absA = new Decimal(a.percentChange).abs();
        const absB = new Decimal(b.percentChange).abs();
        return absB.comparedTo(absA);
      });

    // Take top movers up to limit
    const topMovers = validChanges.slice(0, limit);

    // Separate into gainers and losers
    const gainers = topMovers.filter((c) => new Decimal(c.percentChange).greaterThan(0));
    const losers = topMovers.filter((c) => new Decimal(c.percentChange).lessThan(0));

    return {
      summary: {
        totalTokensTracked: uniqueTokens.length,
        tokensWithPriceData: validChanges.length,
        gainersCount: gainers.length,
        losersCount: losers.length,
      },
      topMovers,
      gainers,
      losers,
    };
  }

  /**
   * NEW ANALYSIS TOOLS - Make the agent more intelligent and proactive
   */

  /**
   * Analyze portfolio diversification
   */
  private async analyzePortfolioDiversification() {
    const holdingRepository = Container.get(HoldingRepository);

    // Get all holdings with complete details
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    if (holdingsWithDetails.length === 0) {
      return {
        message: 'No holdings found in portfolio',
        diversificationScore: 0,
      };
    }

    // Batch fetch prices
    const priceMap = await this.batchFetchPrices(holdingsWithDetails);

    // Calculate values and distributions
    const tokenTypeMap = new Map<string, Decimal>();
    const institutionMap = new Map<string, Decimal>();
    const accountMap = new Map<string, Decimal>();
    let totalValue = new Decimal(0);

    for (const { holding, token, account, institution } of holdingsWithDetails) {
      const balance = new Decimal(holding.balance);
      if (balance.lte(0)) continue;

      const price = priceMap.get(token.id) || new Decimal(0);
      const value = balance.mul(price);
      totalValue = totalValue.add(value);

      // Token type distribution
      const existingType = tokenTypeMap.get(token.typeCode) || new Decimal(0);
      tokenTypeMap.set(token.typeCode, existingType.add(value));

      // Institution distribution
      const existingInst = institutionMap.get(institution.id) || new Decimal(0);
      institutionMap.set(institution.id, existingInst.add(value));

      // Account distribution
      const existingAcct = accountMap.get(account.id) || new Decimal(0);
      accountMap.set(account.id, existingAcct.add(value));
    }

    // Calculate concentration metrics
    const tokenTypes = Array.from(tokenTypeMap.entries()).map(([code, value]) => ({
      code,
      value: value.toString(),
      percentage: totalValue.greaterThan(0) ? value.div(totalValue).mul(100).toFixed(2) : '0.00',
    }));

    const institutions = Array.from(institutionMap.entries())
      .map(([id, value]) => ({
        id,
        value: value.toString(),
        percentage: totalValue.greaterThan(0) ? value.div(totalValue).mul(100).toFixed(2) : '0.00',
      }))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));

    const accounts = Array.from(accountMap.entries())
      .map(([id, value]) => ({
        id,
        value: value.toString(),
        percentage: totalValue.greaterThan(0) ? value.div(totalValue).mul(100).toFixed(2) : '0.00',
      }))
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)));

    // Calculate diversification score (0-100)
    // Higher score = better diversification
    const tokenTypeCount = tokenTypes.length;
    const institutionCount = institutions.length;
    const accountCount = accounts.length;

    // Check concentration (single asset > 50% is risky)
    const topInstitutionPct = institutions[0] ? parseFloat(institutions[0].percentage) : 0;
    const topAccountPct = accounts[0] ? parseFloat(accounts[0].percentage) : 0;

    let score = 0;
    // Token type diversity (max 30 points)
    score += Math.min(tokenTypeCount * 10, 30);
    // Institution diversity (max 25 points)
    score += Math.min(institutionCount * 5, 25);
    // Account diversity (max 25 points)
    score += Math.min(accountCount * 5, 25);
    // Deduct for concentration risk (max 20 points deduction)
    if (topInstitutionPct > 80) score -= 20;
    else if (topInstitutionPct > 60) score -= 15;
    else if (topInstitutionPct > 40) score -= 10;
    if (topAccountPct > 70) score -= 10;

    // Add balance bonus (max 20 points)
    if (tokenTypeCount >= 3 && topInstitutionPct < 50) score += 20;
    else if (tokenTypeCount >= 2 && topInstitutionPct < 60) score += 10;

    score = Math.max(0, Math.min(100, score));

    // Generate risks and recommendations
    const risks: string[] = [];
    const recommendations: string[] = [];

    if (topInstitutionPct > 70) {
      risks.push(
        `High concentration in one institution (${topInstitutionPct.toFixed(1)}%). Platform risk.`
      );
      recommendations.push('Consider spreading assets across multiple institutions');
    }

    if (tokenTypeCount === 1) {
      risks.push('Portfolio contains only one asset type. Limited diversification.');
      recommendations.push('Consider diversifying across different asset classes');
    }

    if (accountCount === 1) {
      risks.push('All holdings in a single account');
      recommendations.push('Consider organizing holdings across multiple accounts');
    }

    return {
      diversificationScore: score,
      totalValue: totalValue.toString(),
      assetTypeCount: tokenTypeCount,
      institutionCount,
      accountCount,
      tokenTypes,
      topInstitution: institutions[0],
      topAccount: accounts[0],
      risks,
      recommendations,
      summary:
        score >= 75
          ? 'Well diversified portfolio'
          : score >= 50
            ? 'Moderately diversified'
            : score >= 25
              ? 'Limited diversification'
              : 'Highly concentrated portfolio',
    };
  }

  /**
   * Compare multiple holdings side-by-side
   */
  private async compareHoldings(tokenSymbols: string[]) {
    const holdingRepository = Container.get(HoldingRepository);
    const _tokenRepository = Container.get(TokenRepository);

    // Get all holdings
    const allHoldings = await holdingRepository.findByUserWithCompleteDetails(this.context.userId);

    // Batch fetch prices
    const priceMap = await this.batchFetchPrices(allHoldings);

    // Find holdings for each symbol
    const comparisons = [];
    let totalPortfolioValue = new Decimal(0);

    // Calculate total portfolio value first
    for (const { holding, token } of allHoldings) {
      const balance = new Decimal(holding.balance);
      const price = priceMap.get(token.id) || new Decimal(0);
      totalPortfolioValue = totalPortfolioValue.add(balance.mul(price));
    }

    for (const symbol of tokenSymbols) {
      const symbolUpper = symbol.toUpperCase();
      const matchingHoldings = allHoldings.filter(
        (h) => h.token.symbol.toUpperCase() === symbolUpper
      );

      if (matchingHoldings.length === 0) {
        comparisons.push({
          symbol: symbolUpper,
          found: false,
          message: 'Not held in portfolio',
        });
        continue;
      }

      // Aggregate across accounts
      let totalBalance = new Decimal(0);
      let totalValue = new Decimal(0);
      const accountsList: string[] = [];

      for (const { holding, token, account } of matchingHoldings) {
        const balance = new Decimal(holding.balance);
        const price = priceMap.get(token.id) || new Decimal(0);
        totalBalance = totalBalance.add(balance);
        totalValue = totalValue.add(balance.mul(price));
        accountsList.push(account.name);
      }

      const currentPrice = matchingHoldings[0]
        ? priceMap.get(matchingHoldings[0].token.id)
        : new Decimal(0);

      comparisons.push({
        symbol: symbolUpper,
        name: matchingHoldings[0]?.token.name,
        found: true,
        balance: totalBalance.toString(),
        currentPrice: currentPrice?.toString(),
        totalValue: totalValue.toString(),
        portfolioPercentage: totalPortfolioValue.greaterThan(0)
          ? totalValue.div(totalPortfolioValue).mul(100).toFixed(2)
          : '0.00',
        accountCount: matchingHoldings.length,
        accounts: accountsList,
      });
    }

    return {
      comparisons,
      totalPortfolioValue: totalPortfolioValue.toString(),
      comparedCount: comparisons.filter((c) => c.found).length,
      notFoundCount: comparisons.filter((c) => !c.found).length,
    };
  }

  /**
   * Suggest portfolio rebalancing based on concentration analysis
   */
  private async suggestRebalancing() {
    // Reuse diversification analysis
    const analysis = await this.analyzePortfolioDiversification();

    const suggestions: Array<{
      type: string;
      current: string;
      target: string;
      action: string;
    }> = [];

    // Analyze token type concentration
    if (analysis.tokenTypes && analysis.tokenTypes.length > 0) {
      const sortedTypes = analysis.tokenTypes.sort(
        (a, b) => parseFloat(b.percentage) - parseFloat(a.percentage)
      );

      const topType = sortedTypes[0];
      if (topType && parseFloat(topType.percentage) > 70) {
        suggestions.push({
          type: 'Asset Type Concentration',
          current: `${topType.code}: ${topType.percentage}%`,
          target: 'Consider reducing to < 60%',
          action: `Diversify into other asset types`,
        });
      }
    }

    // Analyze institution concentration
    if (analysis.topInstitution && parseFloat(analysis.topInstitution.percentage) > 60) {
      suggestions.push({
        type: 'Institution Concentration',
        current: `${analysis.topInstitution.percentage}% in one institution`,
        target: 'Spread across 2-3 institutions',
        action: 'Reduce platform/counterparty risk by diversifying',
      });
    }

    // General recommendations based on diversification score
    if (analysis.diversificationScore < 50) {
      if (analysis.assetTypeCount === 1) {
        suggestions.push({
          type: 'Asset Class Diversity',
          current: '1 asset class',
          target: 'At least 2-3 asset classes',
          action: 'Consider adding stocks, crypto, or other asset types',
        });
      }

      if (analysis.institutionCount === 1) {
        suggestions.push({
          type: 'Platform Diversity',
          current: '1 institution',
          target: '2-3 institutions',
          action: 'Distribute holdings across multiple platforms',
        });
      }
    }

    return {
      diversificationScore: analysis.diversificationScore,
      summary: analysis.summary,
      suggestions,
      risks: analysis.risks,
      currentAllocation: {
        assetTypes: analysis.tokenTypes,
        topInstitution: analysis.topInstitution,
      },
    };
  }

  /**
   * Calculate comprehensive portfolio metrics
   */
  private async calculatePortfolioMetrics() {
    const dashboardOverview = await this.getDashboardOverview();
    const diversification = await this.analyzePortfolioDiversification();
    const priceChanges = await this.get24hPriceChanges(5);

    return {
      overview: dashboardOverview,
      diversification: {
        score: diversification.diversificationScore,
        summary: diversification.summary,
        assetTypeCount: diversification.assetTypeCount,
        institutionCount: diversification.institutionCount,
        accountCount: diversification.accountCount,
      },
      recentActivity: {
        top24hMovers: priceChanges.topMovers,
        gainersCount: priceChanges.gainers?.length || 0,
        losersCount: priceChanges.losers?.length || 0,
      },
      risks: diversification.risks,
    };
  }

  /**
   * Find largest holdings by value
   */
  private async findLargestHoldings(limit = 10) {
    const portfolioByTokens = await this.getPortfolioByTokens();

    if (!portfolioByTokens.tokens || portfolioByTokens.tokens.length === 0) {
      return {
        holdings: [],
        message: 'No holdings found',
      };
    }

    const topHoldings = portfolioByTokens.tokens
      .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)))
      .slice(0, limit);

    const totalValue = new Decimal(portfolioByTokens.totalValue);
    const topHoldingsValue = topHoldings.reduce(
      (sum, h) => sum.add(new Decimal(h.value)),
      new Decimal(0)
    );

    const concentration = totalValue.greaterThan(0)
      ? topHoldingsValue.div(totalValue).mul(100).toFixed(2)
      : '0.00';

    return {
      holdings: topHoldings,
      totalValue: totalValue.toString(),
      topHoldingsValue: topHoldingsValue.toString(),
      concentration: `${concentration}%`,
      message: `Top ${topHoldings.length} holdings represent ${concentration}% of portfolio`,
    };
  }

  /**
   * Find smallest holdings (potential dust)
   */
  private async findSmallestHoldings(limit = 10) {
    const portfolioByTokens = await this.getPortfolioByTokens();

    if (!portfolioByTokens.tokens || portfolioByTokens.tokens.length === 0) {
      return {
        holdings: [],
        message: 'No holdings found',
      };
    }

    const smallestHoldings = portfolioByTokens.tokens
      .filter((h) => new Decimal(h.value).greaterThan(0))
      .sort((a, b) => new Decimal(a.value).comparedTo(new Decimal(b.value)))
      .slice(0, limit);

    return {
      holdings: smallestHoldings,
      count: smallestHoldings.length,
      message:
        smallestHoldings.length > 0
          ? `Found ${smallestHoldings.length} smallest holdings`
          : 'No small holdings found',
    };
  }

  /**
   * Search tokens by type
   */
  private async searchTokensByType(tokenType: string, limit = 20) {
    const tokenRepository = Container.get(TokenRepository);
    // Use findByType which searches by type code
    const matchingTokens = await tokenRepository.findByType(tokenType);

    // Limit results
    const limitedTokens = matchingTokens.slice(0, limit);

    return {
      tokens: limitedTokens.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        name: t.name,
        // Token type is passed in as parameter since findByType doesn't return it
        type: tokenType,
        typeCode: tokenType,
      })),
      count: limitedTokens.length,
      searchTerm: tokenType,
    };
  }

  /**
   * Get detailed account summary
   */
  private async getAccountSummary(accountId: string) {
    const accountDetails = await this.getAccountDetails(accountId);
    const holdings = await this.getAccountHoldings(accountId);

    // Calculate total value
    const holdingRepository = Container.get(HoldingRepository);
    const holdingsWithDetails = await holdingRepository.findByUserWithCompleteDetails(
      this.context.userId
    );

    const accountHoldings = holdingsWithDetails.filter((h) => h.account.id === accountId);
    const priceMap = await this.batchFetchPrices(accountHoldings);

    let totalValue = new Decimal(0);
    const tokenTypeMap = new Map<string, Decimal>();

    for (const { holding, token } of accountHoldings) {
      const balance = new Decimal(holding.balance);
      const price = priceMap.get(token.id) || new Decimal(0);
      const value = balance.mul(price);
      totalValue = totalValue.add(value);

      const existing = tokenTypeMap.get(token.typeCode) || new Decimal(0);
      tokenTypeMap.set(token.typeCode, existing.add(value));
    }

    const assetDistribution = Array.from(tokenTypeMap.entries()).map(([code, value]) => ({
      type: code,
      value: value.toString(),
      percentage: totalValue.greaterThan(0) ? value.div(totalValue).mul(100).toFixed(2) : '0.00',
    }));

    return {
      account: accountDetails,
      totalValue: totalValue.toString(),
      holdingsCount: accountHoldings.length,
      assetDistribution,
      holdings: holdings,
    };
  }

  /**
   * Explain a specific holding in detail
   */
  private async explainHolding(tokenSymbol: string) {
    const holdings = await this.searchHoldings(undefined, tokenSymbol);

    if (holdings.length === 0) {
      return {
        found: false,
        message: `No ${tokenSymbol} holdings found in your portfolio`,
      };
    }

    // Get price data
    const tokenRepository = Container.get(TokenRepository);
    const pricingService = Container.get(PricingService);

    const token = await tokenRepository.findBySymbol(tokenSymbol);
    if (!token) {
      return {
        found: false,
        message: `Token ${tokenSymbol} not found`,
      };
    }

    // Get token with type information
    const tokenWithType = await tokenRepository.findWithType(token.id);
    const typeCode = tokenWithType?.typeCode || 'unknown';

    const price = await pricingService.getTokenPrice(token, 'USD', new Date());

    // Aggregate holdings
    let totalBalance = new Decimal(0);
    let totalValue = new Decimal(0);
    const accountsList: Array<{ accountName: string; balance: string; value: string }> = [];

    for (const holding of holdings) {
      const balance = new Decimal(holding.balance);
      const value = price ? balance.mul(new Decimal(price)) : new Decimal(0);

      totalBalance = totalBalance.add(balance);
      totalValue = totalValue.add(value);

      accountsList.push({
        accountName: holding.accountName,
        balance: balance.toString(),
        value: value.toString(),
      });
    }

    // Get portfolio percentage
    const portfolioByTokens = await this.getPortfolioByTokens();
    const totalPortfolioValue = new Decimal(portfolioByTokens.totalValue);
    const portfolioPercentage = totalPortfolioValue.greaterThan(0)
      ? totalValue.div(totalPortfolioValue).mul(100).toFixed(2)
      : '0.00';

    return {
      found: true,
      token: {
        symbol: token.symbol,
        name: token.name,
        type: typeCode,
      },
      currentPrice: price?.toString(),
      totalBalance: totalBalance.toString(),
      totalValue: totalValue.toString(),
      portfolioPercentage: `${portfolioPercentage}%`,
      accountCount: holdings.length,
      accounts: accountsList,
      summary: `You hold ${totalBalance.toString()} ${tokenSymbol} across ${holdings.length} account(s), worth ${totalValue.toFixed(2)} USD, representing ${portfolioPercentage}% of your portfolio`,
    };
  }
}
