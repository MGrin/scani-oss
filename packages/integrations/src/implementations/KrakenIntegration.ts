/**
 * KrakenIntegration - API Key Integration for Kraken Exchange
 *
 * Handles Kraken trading accounts using API Key authentication
 */

import { ScaniIntegration } from '../base';
import type { KrakenApiService } from '../services/KrakenApiService';
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

export class KrakenIntegration extends ScaniIntegration {
  private readonly krakenService: KrakenApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    krakenService: KrakenApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.krakenService = krakenService;
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

      // Kraken has a single unified spot trading account
      const accountUid = 'kraken-api-account';
      const accounts = [
        {
          externalId: `SPOT_${accountUid}`,
          name: 'Kraken Spot Trading',
          accountType: 'SPOT',
          description: 'Kraken Spot Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'SPOT',
            provider: 'kraken',
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

      let balances: Array<{ asset: string; balance: string }> = [];

      try {
        balances = await this.krakenService.getBalances(apiKey, apiSecret);
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
        // Kraken prefixes some assets (e.g., XXBT for BTC, ZEUR for EUR)
        // Normalize the asset symbol
        let symbol = balance.asset;
        if (symbol.startsWith('X') || symbol.startsWith('Z')) {
          // Remove leading X/Z prefix for common assets
          const unprefixed = symbol.substring(1);
          // Map common Kraken asset codes to standard symbols
          const symbolMap: Record<string, string> = {
            XBT: 'BTC',
            XDG: 'DOGE',
            EUR: 'EUR',
            USD: 'USD',
            GBP: 'GBP',
            CAD: 'CAD',
            JPY: 'JPY',
          };
          symbol = symbolMap[unprefixed] || unprefixed;
        }

        const holding: IntegrationHolding = {
          symbol: symbol.toUpperCase(),
          name: symbol,
          balance: balance.balance,
          decimals: 8,
          tokenType: detectTokenType(symbol.toUpperCase()),
          externalTokenId: balance.asset,
          metadata: {
            originalAsset: balance.asset,
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
          provider: 'kraken',
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
      return await this.krakenService.validateApiKey(apiKey, apiSecret);
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
