/**
 * BitgetIntegration - API Key Integration for Bitget Exchange
 *
 * Handles Bitget spot accounts using API Key authentication.
 * Note: Bitget requires a passphrase in addition to apiKey and apiSecret.
 */

import { ScaniIntegration } from '../base';
import type { BitgetApiService } from '../services/BitgetApiService';
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

export class BitgetIntegration extends ScaniIntegration {
  private readonly bitgetService: BitgetApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    bitgetService: BitgetApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.bitgetService = bitgetService;
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

      // Bitget has a single spot account
      const accountUid = 'bitget-api-account';
      const accounts = [
        {
          externalId: `SPOT_${accountUid}`,
          name: 'Bitget Spot Account',
          accountType: 'SPOT',
          description: 'Bitget Spot Trading Account',
          metadata: {
            uid: accountUid,
            accountType: 'SPOT',
            provider: 'bitget',
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

      let balances: Array<{
        coin: string;
        available: string;
        frozen: string;
        locked: string;
      }> = [];

      try {
        balances = await this.bitgetService.getBalances(apiKey, apiSecret, passphrase);
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
        const totalBalance =
          parseFloat(balance.available) + parseFloat(balance.frozen) + parseFloat(balance.locked);

        const holding: IntegrationHolding = {
          symbol: balance.coin.toUpperCase(),
          name: balance.coin,
          balance: totalBalance.toString(),
          decimals: 8,
          tokenType: detectTokenType(balance.coin.toUpperCase()),
          externalTokenId: balance.coin,
          metadata: {
            available: balance.available,
            frozen: balance.frozen,
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
          provider: 'bitget',
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
      return await this.bitgetService.validateApiKey(apiKey, apiSecret, passphrase);
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
