/**
 * OkxIntegration - API Key Integration for OKX Exchange
 *
 * Handles OKX trading accounts using API Key authentication.
 * Note: OKX requires a passphrase in addition to apiKey and apiSecret.
 */

import { ScaniIntegration } from '../base';
import type { OkxApiService } from '../services/OkxApiService';
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

export class OkxIntegration extends ScaniIntegration {
  private readonly okxService: OkxApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    okxService: OkxApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.okxService = okxService;
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

      // OKX has a single trading account
      const accountUid = 'okx-api-account';
      const accounts = [
        {
          externalId: `TRADING_${accountUid}`,
          name: 'OKX Trading Account',
          accountType: 'TRADING',
          description: 'OKX Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'TRADING',
            provider: 'okx',
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

      let balances: Array<{ ccy: string; cashBal: string; eqUsd: string }> = [];

      try {
        balances = await this.okxService.getBalances(apiKey, apiSecret, passphrase);
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
          symbol: balance.ccy.toUpperCase(),
          name: balance.ccy,
          balance: balance.cashBal,
          decimals: 8,
          tokenType: detectTokenType(balance.ccy.toUpperCase()),
          externalTokenId: balance.ccy,
          metadata: {
            eqUsd: balance.eqUsd,
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
          provider: 'okx',
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

    try {
      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      const passphrase = credentials.passphrase as string;
      return await this.okxService.validateApiKey(apiKey, apiSecret, passphrase);
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
