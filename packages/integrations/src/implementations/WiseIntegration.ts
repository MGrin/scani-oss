/**
 * WiseIntegration - API Key Integration for Wise (TransferWise)
 *
 * Handles Wise multi-currency accounts using Bearer token authentication.
 * Returns fiat currency balances across all supported currencies.
 */

import { ScaniIntegration } from '../base';
import type { WiseApiService, WiseBalance } from '../services/WiseApiService';
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

export class WiseIntegration extends ScaniIntegration {
  private readonly wiseService: WiseApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    wiseService: WiseApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.wiseService = wiseService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      if (!credentials?.apiKey) {
        return {
          accounts: [],
          total: 0,
          errors: ['No API token provided'],
        };
      }

      const apiToken = credentials.apiKey as string;
      const isValid = await this.validateCredentials({ apiKey: apiToken });
      if (!isValid) {
        return {
          accounts: [],
          total: 0,
          errors: ['Invalid API token'],
        };
      }

      const profiles = await this.wiseService.getProfiles(apiToken);

      const accounts = profiles.map((profile) => ({
        externalId: `${profile.type}_${profile.id}`,
        name: `Wise ${profile.type === 'PERSONAL' ? 'Personal' : 'Business'} - ${profile.fullName}`,
        accountType: profile.type,
        description: `Wise ${profile.type === 'PERSONAL' ? 'Personal' : 'Business'} Account`,
        metadata: {
          profileId: profile.id,
          profileType: profile.type,
          fullName: profile.fullName,
          provider: 'wise',
        },
        isActive: true,
      }));

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
      if (!credentials?.apiKey) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No API token provided'],
        };
      }

      const apiToken = credentials.apiKey as string;

      // Extract profileId from accountId (format: TYPE_profileId)
      const parts = accountId.split('_');
      if (parts.length < 2) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: [`Invalid account ID format: ${accountId}`],
        };
      }
      const profileIdStr = parts[1] as string;
      const profileId = parseInt(profileIdStr, 10);
      if (Number.isNaN(profileId)) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: [`Invalid profile ID in account ID: ${accountId}`],
        };
      }

      let balances: WiseBalance[] | undefined;
      try {
        balances = await this.wiseService.getBalances(apiToken, profileId);
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
          name: balance.currency.toUpperCase(),
          balance: balance.amount.value.toString(),
          decimals: 2,
          tokenType: 'fiat' as const,
          externalTokenId: `wise-${balance.id}`,
          metadata: {
            balanceId: balance.id,
            balanceType: balance.type,
            currency: balance.currency,
            provider: 'wise',
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
        decimals: 2,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'wise',
          externalId: holding.externalTokenId,
          currency: holding.symbol,
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    if (!credentials?.apiKey) {
      return false;
    }

    const apiToken = credentials.apiKey as string;
    return await this.wiseService.validateApiToken(apiToken);
  }

  async checkHealth(): Promise<IntegrationStatus> {
    try {
      // Health check without credentials just verifies the service is configured
      return {
        isHealthy: true,
        details: {
          authType: this.authConfig.type,
          institutionId: this.institutionId,
          provider: 'wise',
        },
      };
    } catch (error) {
      return {
        isHealthy: false,
        lastError: error instanceof Error ? error.message : 'Unknown error',
        details: {
          authType: this.authConfig.type,
          institutionId: this.institutionId,
          provider: 'wise',
        },
      };
    }
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    // API tokens don't need refresh - they are always valid until manually revoked
    // Return the same credentials unchanged
    return {
      refreshed: false,
      message: 'API tokens do not expire - no refresh needed',
    };
  }
}
