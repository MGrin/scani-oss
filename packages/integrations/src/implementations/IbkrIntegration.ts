/**
 * IbkrIntegration - Flex Query Integration for Interactive Brokers
 *
 * Handles IBKR portfolio data using the Flex Web Service API.
 * Authentication requires a Flex Web Service Token and a Flex Query ID,
 * both configured in IBKR Account Management.
 */

import { ScaniIntegration } from '../base';
import type { IbkrFlexQueryService } from '../services/IbkrFlexQueryService';
import type {
  AuthConfig,
  FetchAccountsResult,
  FetchHoldingsResult,
  ICredentialManager,
  IntegrationHolding,
  IntegrationStatus,
  IWalletManager,
  RateLimiter,
  TokenMappingResult,
} from '../types';

/**
 * Map IBKR assetCategory to Scani token type.
 * CASH → fiat; all others (STK, OPT, FUT, BOND, FUND, WAR, etc.) → stock.
 */
function mapAssetCategoryToTokenType(assetCategory: string): string {
  if (assetCategory.toUpperCase() === 'CASH') {
    return 'fiat';
  }
  return 'stock';
}

export class IbkrIntegration extends ScaniIntegration {
  private readonly ibkrService: IbkrFlexQueryService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    ibkrService: IbkrFlexQueryService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.ibkrService = ibkrService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      if (!credentials?.token || !credentials?.queryId) {
        return {
          accounts: [],
          total: 0,
          errors: ['No Flex Web Service Token or Query ID provided'],
        };
      }

      const token = credentials.token as string;
      const queryId = credentials.queryId as string;
      const isValid = await this.validateCredentials({ token, queryId });
      if (!isValid) {
        return {
          accounts: [],
          total: 0,
          errors: ['Invalid Flex Web Service Token or Query ID'],
        };
      }

      const accounts = [
        {
          externalId: 'ibkr-flex-portfolio',
          name: 'IBKR Portfolio',
          accountType: 'PORTFOLIO',
          description: 'Interactive Brokers Portfolio via Flex Query',
          metadata: {
            provider: 'ibkr',
            accountType: 'PORTFOLIO',
          },
          isActive: true,
        },
      ];

      return {
        accounts,
        total: accounts.length,
      };
    } catch (error) {
      return {
        accounts: [],
        total: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }

  async fetchHoldings(
    accountId: string,
    credentials?: Record<string, unknown>
  ): Promise<FetchHoldingsResult> {
    try {
      if (!credentials?.token || !credentials?.queryId) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No Flex Web Service Token or Query ID provided'],
        };
      }

      const token = credentials.token as string;
      const queryId = credentials.queryId as string;

      let data: Awaited<ReturnType<IbkrFlexQueryService['getFlexQueryData']>>;
      try {
        data = await this.ibkrService.getFlexQueryData(token, queryId);
      } catch (error) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: [
            `Failed to fetch IBKR Flex Query data: ${error instanceof Error ? error.message : 'Unknown error'}`,
          ],
        };
      }

      const holdings: IntegrationHolding[] = [];

      // Map open positions to holdings
      for (const pos of data.positions) {
        const tokenType = mapAssetCategoryToTokenType(pos.assetCategory);
        holdings.push({
          symbol: pos.symbol.toUpperCase(),
          name: pos.description || pos.symbol,
          balance: pos.position,
          decimals: 2,
          tokenType,
          externalTokenId: pos.symbol,
          metadata: {
            assetCategory: pos.assetCategory,
            markPrice: pos.markPrice,
            positionValue: pos.positionValue,
            currency: pos.currency,
            listingExchange: pos.listingExchange,
            provider: 'ibkr',
          },
        });
      }

      // Warn if no cash balances found (may indicate Flex Query config issue)
      if (data.cashBalances.length === 0 && data.positions.length > 0) {
        console.warn(
          'IBKR: No cash balances found in Flex Query response. ' +
            'Ensure your Flex Query configuration includes the "Cash Report" section.'
        );
      }

      // Map cash balances to holdings
      for (const cash of data.cashBalances) {
        holdings.push({
          symbol: cash.currency.toUpperCase(),
          name: cash.currency,
          balance: cash.endingCash,
          decimals: 2,
          tokenType: 'fiat',
          externalTokenId: `CASH_${cash.currency}`,
          metadata: {
            assetCategory: 'CASH',
            currency: cash.currency,
            provider: 'ibkr',
          },
        });
      }

      return {
        holdings,
        total: holdings.length,
        accountId,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        holdings: [],
        total: 0,
        accountId,
        timestamp: new Date(),
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }

  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    const tokenType =
      holding.tokenType ??
      mapAssetCategoryToTokenType((holding.metadata?.assetCategory as string) ?? '');

    const providerMetadata: Record<string, unknown> = {
      provider: 'ibkr',
      externalId: holding.externalTokenId,
      tokenType,
      assetCategory: holding.metadata?.assetCategory,
      markPrice: holding.metadata?.markPrice,
      positionValue: holding.metadata?.positionValue,
      currency: holding.metadata?.currency,
      listingExchange: holding.metadata?.listingExchange,
    };

    // Add exchangeInfo for pricing service routing (stocks/ETFs)
    if (tokenType === 'stock' && holding.metadata?.currency) {
      providerMetadata.exchangeInfo = {
        exchange: holding.metadata.listingExchange || '',
        currency: holding.metadata.currency,
      };
    }

    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: '',
        decimals: 2,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify(providerMetadata),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    if (!credentials?.token || !credentials?.queryId) {
      return false;
    }

    try {
      const token = credentials.token as string;
      const queryId = credentials.queryId as string;
      return await this.ibkrService.validateCredentials(token, queryId);
    } catch (_error) {
      return false;
    }
  }

  async checkHealth(): Promise<IntegrationStatus> {
    return {
      isHealthy: true,
      details: {
        authType: this.authConfig.type,
        institutionId: this.institutionId,
        provider: 'ibkr',
      },
    };
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    // Flex Web Service tokens don't expire automatically - they are managed in IBKR Account Management
    return {
      refreshed: false,
      message: 'IBKR Flex Web Service tokens do not expire - no refresh needed',
    };
  }
}
