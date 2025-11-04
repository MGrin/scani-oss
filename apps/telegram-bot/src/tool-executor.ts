import Decimal from 'decimal.js';
import { Container } from 'typedi';
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
          return await this.updateHolding(
            parameters.holdingId,
            parameters.quantity,
            parameters.costBasis
          );

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

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      throw error;
    }
  }

  private async getDashboardOverview() {
    const { DashboardService } = await import('../../backend/src/application/services');
    const dashboardService = Container.get(DashboardService);
    return await dashboardService.getDashboardOverview(this.context.userId);
  }

  private async listAccounts() {
    const { AccountService } = await import('../../backend/src/application/services');
    const accountService = Container.get(AccountService);
    return await accountService.getAccountsByUserId(this.context.userId);
  }

  private async getAccountDetails(accountId: string) {
    const { AccountService } = await import('../../backend/src/application/services');
    const accountService = Container.get(AccountService);
    return await accountService.getAccountById(this.context.userId, accountId);
  }

  private async deleteAccount(accountId: string) {
    const { AccountService } = await import('../../backend/src/application/services');
    const accountService = Container.get(AccountService);
    return await accountService.deleteAccount(accountId, this.context.userId);
  }

  private async listHoldings(accountId?: string) {
    const { HoldingService } = await import('../../backend/src/application/services');
    const holdingService = Container.get(HoldingService);

    // Get user info for holdings query
    const { UserContextService } = await import('../../backend/src/application/services');
    const userContextService = Container.get(UserContextService);
    const dbUser = await userContextService.getUserById(this.context.userId);

    if (!dbUser) {
      throw new Error('User not found');
    }

    return await holdingService.getHoldingsByAccountIdWithDetails(dbUser, accountId);
  }

  private async updateHolding(holdingId: string, quantity?: number, costBasis?: number) {
    const { UpdateHoldingUseCase } = await import('../../backend/src/application/use-cases');
    const updateHoldingUseCase = Container.get(UpdateHoldingUseCase);

    const data: any = {};
    if (quantity !== undefined) data.quantity = new Decimal(quantity);
    if (costBasis !== undefined) data.costBasis = new Decimal(costBasis);

    return await updateHoldingUseCase.execute(holdingId, data, this.context.userId);
  }

  private async deleteHolding(holdingId: string) {
    const { DeleteHoldingUseCase } = await import('../../backend/src/application/use-cases');
    const deleteHoldingUseCase = Container.get(DeleteHoldingUseCase);
    return await deleteHoldingUseCase.execute(holdingId, this.context.userId);
  }

  private async searchTokens(query: string, limit = 10) {
    const { TokenRepository } = await import('../../backend/src/infrastructure/repositories');
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
    const { PricingService } = await import('../../backend/src/application/services');
    const pricingService = Container.get(PricingService);
    // Find token by symbol first
    const { TokenRepository } = await import('../../backend/src/infrastructure/repositories');
    const tokenRepository = Container.get(TokenRepository);
    const token = await tokenRepository.getTokenBySymbol(symbol);
    if (!token) {
      throw new Error(`Token not found: ${symbol}`);
    }
    const price = await pricingService.getPrice(token.id);
    return { symbol, price: price?.toString() };
  }

  private async listInstitutions(type?: string) {
    const { InstitutionRepository } = await import('../../backend/src/infrastructure/repositories');
    const institutionRepository = Container.get(InstitutionRepository);
    return await institutionRepository.getAllInstitutions();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Holdings array type is dynamic
  private async importHoldings(accountId: string, holdings: any[]) {
    const { CreateHoldingsWithDependenciesUseCase } = await import(
      '../../backend/src/application/use-cases'
    );
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
    const { InstitutionTypeRepository } = await import(
      '../../backend/src/infrastructure/repositories'
    );
    const institutionTypeRepository = Container.get(InstitutionTypeRepository);
    return await institutionTypeRepository.getAllInstitutionTypes();
  }

  private async listAccountTypes() {
    const { AccountTypeRepository } = await import('../../backend/src/infrastructure/repositories');
    const accountTypeRepository = Container.get(AccountTypeRepository);
    return await accountTypeRepository.getAllAccountTypes();
  }
}
