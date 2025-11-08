import {
  AccountService,
  DashboardService,
  HoldingService,
  PricingService,
  UserContextService,
  UserService,
} from '@scani/backend/src/application/services';
import {
  CreateHoldingsWithDependenciesUseCase,
  DeleteHoldingUseCase,
  ImportWalletAddressUseCase,
  UpdateHoldingUseCase,
} from '@scani/backend/src/application/use-cases';
import type { UpdateHoldingInput } from '@scani/backend/src/application/use-cases/UpdateHoldingUseCase';
import { BlockchainServiceManager } from '@scani/backend/src/infrastructure/external-services/blockchain';
import {
  AccountTypeRepository,
  HoldingRepository,
  InstitutionRepository,
  InstitutionTypeRepository,
  TokenPriceRepository,
  TokenRepository,
} from '@scani/backend/src/infrastructure/repositories';
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

        case 'generatePortfolioChart':
          return await this.generatePortfolioChart(parameters.chartType, parameters.dataType);

        case 'get24hPriceChanges':
          return await this.get24hPriceChanges(parameters.limit);

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

    const data: UpdateHoldingInput = {};
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
}
