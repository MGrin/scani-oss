/**
 * GateioIntegration - API Key Integration for Gate.io Exchange
 *
 * Handles Gate.io trading accounts using API Key + Secret authentication
 */

import { ScaniIntegration } from '../base';
import type { GateioApiService } from '../services/GateioApiService';
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

export class GateioIntegration extends ScaniIntegration {
  private readonly gateioService: GateioApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    gateioService: GateioApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.gateioService = gateioService;
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

      // Gate.io has a single unified spot trading account
      const accountUid = 'gateio-api-account';
      const accounts = [
        {
          externalId: `SPOT_${accountUid}`,
          name: 'Gate.io Spot Trading',
          accountType: 'SPOT',
          description: 'Gate.io Spot Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'SPOT',
            provider: 'gateio',
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

      let balances: Array<{ currency: string; available: string; locked: string }> = [];

      try {
        balances = await this.gateioService.getBalances(apiKey, apiSecret);
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
        const totalBalance = parseFloat(balance.available) + parseFloat(balance.locked);
        if (totalBalance === 0) {
          return null;
        }

        const holding: IntegrationHolding = {
          symbol: balance.currency.toUpperCase(),
          name: balance.currency,
          balance: totalBalance.toString(),
          decimals: 8,
          tokenType: 'crypto' as const,
          externalTokenId: balance.currency,
          metadata: {
            available: balance.available,
            locked: balance.locked,
            accountType: 'SPOT',
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
          provider: 'gateio',
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

    try {
      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      return await this.gateioService.validateApiKey(apiKey, apiSecret);
    } catch (_error) {
      return false;
    }
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
