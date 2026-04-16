/**
 * CoinbaseIntegration - API Key Integration for Coinbase Exchange
 *
 * Handles Coinbase accounts using API Key authentication
 */

import { ScaniIntegration } from '../base';
import type { CoinbaseApiService } from '../services/CoinbaseApiService';
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

export class CoinbaseIntegration extends ScaniIntegration {
  private readonly coinbaseService: CoinbaseApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    coinbaseService: CoinbaseApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.coinbaseService = coinbaseService;
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

      // Coinbase uses a single portfolio account
      const accountUid = 'coinbase-api-account';
      const accounts = [
        {
          externalId: `PORTFOLIO_${accountUid}`,
          name: 'Coinbase Portfolio',
          accountType: 'PORTFOLIO',
          description: 'Coinbase Portfolio Account',
          metadata: {
            uid: accountUid,
            accountType: 'PORTFOLIO',
            provider: 'coinbase',
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

      let balances: Array<{
        currency: string;
        balance: string;
        name: string;
        type: string;
      }> = [];

      try {
        balances = await this.coinbaseService.getBalances(apiKey, apiSecret);
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
        // Coinbase fiat wallets map to 'fiat', everything else to 'crypto'
        const tokenType = balance.type === 'fiat' ? ('fiat' as const) : ('crypto' as const);

        const holding: IntegrationHolding = {
          symbol: balance.currency.toUpperCase(),
          name: balance.name || balance.currency,
          balance: balance.balance,
          decimals: 8,
          tokenType,
          externalTokenId: balance.currency,
          metadata: {
            walletType: balance.type,
            accountType: 'PORTFOLIO',
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
          provider: 'coinbase',
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
      return await this.coinbaseService.validateApiKey(apiKey, apiSecret);
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
