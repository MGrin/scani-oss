/**
 * BitpandaIntegration - API Token Integration for Bitpanda
 *
 * Bitpanda uses a single-token auth model (X-Api-Key). We surface the
 * token via the `apiKey` credentials slot; `apiSecret` is ignored.
 *
 * Docs: https://developers.bitpanda.com/
 */

import { ScaniIntegration } from '../base';
import type { BitpandaApiService } from '../services/BitpandaApiService';
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

export class BitpandaIntegration extends ScaniIntegration {
  private readonly apiService: BitpandaApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: BitpandaApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.apiService = apiService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      const apiKey = (credentials?.apiKey ?? credentials?.apiToken) as string | undefined;
      if (!apiKey) {
        return { accounts: [], total: 0, errors: ['No API token provided'] };
      }
      const isValid = await this.apiService.validateApiKey(apiKey);
      if (!isValid) {
        return { accounts: [], total: 0, errors: ['Invalid API token'] };
      }

      const accounts = [
        {
          externalId: 'TRADING_bitpanda-account',
          name: 'Bitpanda Account',
          accountType: 'TRADING',
          description: 'Bitpanda crypto + fiat wallets',
          metadata: { provider: 'bitpanda', accountType: 'TRADING' },
          isActive: true,
        },
      ];
      return { accounts, total: accounts.length };
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
      const apiKey = (credentials?.apiKey ?? credentials?.apiToken) as string | undefined;
      if (!apiKey) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No API token provided'],
        };
      }

      const balances = await this.apiService.getAllBalances(apiKey);
      const holdings: IntegrationHolding[] = balances.map((b) => ({
        symbol: b.symbol,
        name: b.walletName,
        balance: b.balance,
        decimals: 8,
        tokenType: b.walletType === 'fiat' ? 'fiat' : detectTokenType(b.symbol),
        externalTokenId: b.walletId,
        metadata: {
          accountType: 'TRADING',
          walletType: b.walletType,
          walletId: b.walletId,
        },
      }));

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
          provider: 'bitpanda',
          externalId: holding.externalTokenId,
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    const apiKey = (credentials?.apiKey ?? credentials?.apiToken) as string | undefined;
    if (!apiKey) return false;
    return await this.apiService.validateApiKey(apiKey);
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    return { refreshed: false, message: 'API tokens do not expire - no refresh needed' };
  }
}
