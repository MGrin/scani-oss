/**
 * CoincheckIntegration - API Key Integration for Coincheck (Japan)
 *
 * Docs: https://coincheck.com/documents/exchange/api
 */

import { ScaniIntegration } from '../base';
import type { CoincheckApiService } from '../services/CoincheckApiService';
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

export class CoincheckIntegration extends ScaniIntegration {
  private readonly apiService: CoincheckApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: CoincheckApiService,
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
            externalId: 'TRADING_coincheck-api-account',
            name: 'Coincheck Trading Account',
            accountType: 'TRADING',
            description: 'Coincheck Trading Account',
            metadata: { provider: 'coincheck', accountType: 'TRADING' },
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
      const rows = await this.apiService.getBalances(apiKey, apiSecret);

      const holdings: IntegrationHolding[] = rows.map((row) => {
        const symbol = row.currency.toUpperCase();
        return {
          symbol,
          name: symbol,
          balance: row.balance,
          decimals: 8,
          tokenType: detectTokenType(symbol),
          externalTokenId: row.currency,
          metadata: { accountType: 'TRADING' },
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
        decimals: 8,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'coincheck',
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
