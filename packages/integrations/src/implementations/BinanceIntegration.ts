/**
 * BinanceIntegration - API Key Integration for Binance Exchange
 *
 * Handles Binance trading accounts using API Key authentication
 */

import { ScaniIntegration } from '../base';
import type { BinanceApiService } from '../services/BinanceApiService';
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

export class BinanceIntegration extends ScaniIntegration {
  private readonly binanceService: BinanceApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    binanceService: BinanceApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.binanceService = binanceService;
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

      // Detect which account types are available
      const accountTypes = await this.binanceService.detectAccountTypes(apiKey, apiSecret);
      const accountUid = 'binance-api-account';
      const accounts = [];

      // Create account entries for each available type
      if (accountTypes.spot) {
        accounts.push({
          externalId: `SPOT_${accountUid}`,
          name: 'Binance Spot Trading',
          accountType: 'SPOT',
          description: 'Binance Spot Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'SPOT',
            provider: 'binance',
          },
          isActive: true,
        });
      }

      if (accountTypes.margin) {
        accounts.push({
          externalId: `MARGIN_${accountUid}`,
          name: 'Binance Cross Margin',
          accountType: 'MARGIN',
          description: 'Binance Cross Margin Account',
          metadata: {
            uid: accountUid,
            accountType: 'MARGIN',
            provider: 'binance',
          },
          isActive: true,
        });
      }

      if (accountTypes.futures) {
        accounts.push({
          externalId: `FUTURES_${accountUid}`,
          name: 'Binance USDⓈ-M Futures',
          accountType: 'FUTURES',
          description: 'Binance USDⓈ-M Futures Account',
          metadata: {
            uid: accountUid,
            accountType: 'FUTURES',
            provider: 'binance',
          },
          isActive: true,
        });
      }

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

      const [accountType] = accountId.split('_');

      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;

      let balances: Array<{ asset: string; free: string; locked: string }> = [];

      if (accountType === 'SPOT') {
        // Fetch spot balances using API key authentication
        try {
          balances = await this.binanceService.getSpotBalances(apiKey, apiSecret);
        } catch (error) {
          return {
            holdings: [],
            total: 0,
            accountId,
            timestamp: new Date(),
            errors: [
              `Failed to fetch spot balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
            ],
          };
        }
      } else if (accountType === 'MARGIN') {
        // Fetch margin balances using API key authentication
        try {
          balances = await this.binanceService.getMarginBalances(apiKey, apiSecret);
        } catch (error) {
          return {
            holdings: [],
            total: 0,
            accountId,
            timestamp: new Date(),
            errors: [
              `Failed to fetch margin balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
            ],
          };
        }
      } else if (accountType === 'FUTURES') {
        // Fetch futures balances using API key authentication
        try {
          balances = await this.binanceService.getFuturesBalances(apiKey, apiSecret);
        } catch (error) {
          return {
            holdings: [],
            total: 0,
            accountId,
            timestamp: new Date(),
            errors: [
              `Failed to fetch futures balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
            ],
          };
        }
      } else {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: [`Unknown account type: ${accountType}`],
        };
      }

      const holdingsWithNull = balances.map((balance) => {
        const totalBalance = parseFloat(balance.free) + parseFloat(balance.locked);

        const holding: IntegrationHolding = {
          symbol: balance.asset.toUpperCase(),
          name: balance.asset,
          balance: totalBalance.toString(),
          decimals: 8,
          tokenType: detectTokenType(balance.asset.toUpperCase()),
          externalTokenId: balance.asset,
          metadata: {
            free: balance.free,
            locked: balance.locked,
            accountType,
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
          provider: 'binance',
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

    // Let the service-level throw propagate so callers surface the real
    // provider error instead of collapsing it to an opaque `false`.
    const apiKey = credentials.apiKey as string;
    const apiSecret = credentials.apiSecret as string;
    return await this.binanceService.validateApiKey(apiKey, apiSecret);
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
