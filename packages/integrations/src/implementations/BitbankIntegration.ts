/**
 * BitbankIntegration - API Key Integration for bitbank.cc (Japan)
 *
 * Docs: https://github.com/bitbankinc/bitbank-api-docs
 */

import { ScaniIntegration } from '../base';
import type { BitbankApiService } from '../services/BitbankApiService';
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

export class BitbankIntegration extends ScaniIntegration {
  private readonly apiService: BitbankApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: BitbankApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.apiService = apiService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      if (!credentials?.apiKey || !credentials?.apiSecret) {
        return { accounts: [], total: 0, errors: ['No API Key or Secret provided'] };
      }
      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      const isValid = await this.validateCredentials({ apiKey, apiSecret });
      if (!isValid) {
        return { accounts: [], total: 0, errors: ['Invalid API Key or Secret'] };
      }
      return {
        accounts: [
          {
            externalId: 'TRADING_bitbank-api-account',
            name: 'bitbank Trading Account',
            accountType: 'TRADING',
            description: 'bitbank.cc Trading Account',
            metadata: { provider: 'bitbank', accountType: 'TRADING' },
            isActive: true,
          },
        ],
        total: 1,
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
      const assets = await this.apiService.getAssets(apiKey, apiSecret);

      const holdings: IntegrationHolding[] = assets.map((asset) => {
        const symbol = asset.asset.toUpperCase();
        return {
          symbol,
          name: symbol,
          balance: asset.onhand_amount,
          decimals: asset.amount_precision ?? 8,
          tokenType: detectTokenType(symbol),
          externalTokenId: asset.asset,
          metadata: {
            accountType: 'TRADING',
            locked: asset.locked_amount,
            free: asset.free_amount,
          },
        };
      });

      return { holdings, total: holdings.length, accountId, timestamp: new Date() };
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
        decimals: holding.decimals,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'bitbank',
          externalId: holding.externalTokenId,
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    if (!credentials?.apiKey || !credentials?.apiSecret) return false;
    return await this.apiService.validateApiKey(
      credentials.apiKey as string,
      credentials.apiSecret as string
    );
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    return { refreshed: false, message: 'API keys do not expire - no refresh needed' };
  }
}
