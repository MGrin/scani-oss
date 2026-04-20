/**
 * BitstampIntegration - API Key Integration for Bitstamp Exchange
 *
 * Handles Bitstamp accounts using API Key authentication
 */

import { ScaniIntegration } from '../base';
import type { BitstampApiService } from '../services/BitstampApiService';
import type {
  AuthConfig,
  FetchAccountsResult,
  FetchHoldingsResult,
  ICredentialManager,
  IntegrationHolding,
  IWalletManager,
  RateLimiter,
  TokenMappingResult,
} from '../types';
import { detectTokenType } from '../utils/currencyDetection';

export class BitstampIntegration extends ScaniIntegration {
  private readonly bitstampService: BitstampApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    bitstampService: BitstampApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.bitstampService = bitstampService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      if (!credentials?.apiKey || !credentials?.apiSecret) {
        return {
          accounts: [],
          total: 0,
          errors: ['No API Key or Secret provided'],
        };
      }

      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      const isValid = await this.validateCredentials({ apiKey, apiSecret });
      if (!isValid) {
        return {
          accounts: [],
          total: 0,
          errors: ['Invalid API Key or Secret'],
        };
      }

      // Bitstamp has a single trading account
      const accountUid = 'bitstamp-api-account';
      const accounts = [
        {
          externalId: `TRADING_${accountUid}`,
          name: 'Bitstamp Trading Account',
          accountType: 'TRADING',
          description: 'Bitstamp Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'TRADING',
            provider: 'bitstamp',
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
      if (!credentials?.apiKey || !credentials?.apiSecret) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No API Key or Secret provided'],
        };
      }

      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;

      let balances: Array<{ currency: string; balance: string }> = [];

      try {
        balances = await this.bitstampService.getBalances(apiKey, apiSecret);
      } catch (error) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: [
            `Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
          ],
        };
      }

      const holdingsWithNull = balances.map((balance) => {
        const holding: IntegrationHolding = {
          symbol: balance.currency.toUpperCase(),
          name: balance.currency,
          balance: balance.balance,
          decimals: 8,
          tokenType: detectTokenType(balance.currency.toUpperCase()),
          externalTokenId: balance.currency,
          metadata: {
            accountType: 'TRADING',
          },
        };
        return holding;
      });

      const holdings: IntegrationHolding[] = holdingsWithNull.filter(
        (h) => h !== null
      ) as IntegrationHolding[];

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
    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: '',
        decimals: 8,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'bitstamp',
          externalId: holding.externalTokenId,
          accountType: holding.metadata?.accountType,
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    if (!credentials?.apiKey || !credentials?.apiSecret) {
      return false;
    }

    const apiKey = credentials.apiKey as string;
    const apiSecret = credentials.apiSecret as string;
    return await this.bitstampService.validateApiKey(apiKey, apiSecret);
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    // API keys don't need refresh - they are always valid until manually revoked
    // Return the same credentials unchanged
    return {
      refreshed: false,
      message: 'API keys do not expire - no refresh needed',
    };
  }
}
