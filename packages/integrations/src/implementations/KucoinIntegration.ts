/**
 * KucoinIntegration - API Key Integration for KuCoin Exchange
 *
 * Handles KuCoin trading accounts using API Key + Secret + Passphrase authentication
 */

import { ScaniIntegration } from '../base';
import type { KucoinApiService } from '../services/KucoinApiService';
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

export class KucoinIntegration extends ScaniIntegration {
  private readonly kucoinService: KucoinApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    kucoinService: KucoinApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.kucoinService = kucoinService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      if (!credentials?.apiKey || !credentials?.apiSecret || !credentials?.passphrase) {
        return {
          accounts: [],
          total: 0,
          errors: ['No API Key, Secret, or Passphrase provided'],
        };
      }

      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      const passphrase = credentials.passphrase as string;
      const isValid = await this.validateCredentials({ apiKey, apiSecret, passphrase });
      if (!isValid) {
        return {
          accounts: [],
          total: 0,
          errors: ['Invalid API Key, Secret, or Passphrase'],
        };
      }

      // KuCoin has a single unified spot trading account
      const accountUid = 'kucoin-api-account';
      const accounts = [
        {
          externalId: `SPOT_${accountUid}`,
          name: 'KuCoin Spot Trading',
          accountType: 'SPOT',
          description: 'KuCoin Spot Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'SPOT',
            provider: 'kucoin',
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
      if (!credentials?.apiKey || !credentials?.apiSecret || !credentials?.passphrase) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No API Key, Secret, or Passphrase provided'],
        };
      }

      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      const passphrase = credentials.passphrase as string;

      let balances: Array<{ currency: string; balance: string; type: string }> = [];

      try {
        balances = await this.kucoinService.getBalances(apiKey, apiSecret, passphrase);
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

      // Aggregate balances by currency across account types (main, trade, margin)
      const aggregated = new Map<string, number>();
      for (const balance of balances) {
        const amount = parseFloat(balance.balance);
        if (amount === 0) continue;
        const existing = aggregated.get(balance.currency) || 0;
        aggregated.set(balance.currency, existing + amount);
      }

      const holdings: IntegrationHolding[] = [];
      for (const [currency, totalBalance] of aggregated) {
        holdings.push({
          symbol: currency.toUpperCase(),
          name: currency,
          balance: totalBalance.toString(),
          decimals: 8,
          tokenType: detectTokenType(currency.toUpperCase()),
          externalTokenId: currency,
          metadata: {
            accountType: 'SPOT',
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
    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: '',
        decimals: 8,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'kucoin',
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
    if (!credentials?.apiKey || !credentials?.apiSecret || !credentials?.passphrase) {
      return false;
    }

    const apiKey = credentials.apiKey as string;
    const apiSecret = credentials.apiSecret as string;
    const passphrase = credentials.passphrase as string;
    return await this.kucoinService.validateApiKey(apiKey, apiSecret, passphrase);
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
