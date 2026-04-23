/**
 * MercuryIntegration - Mercury Bank (US neobank)
 *
 * Single bearer-token auth. We read /accounts, exposing each account's
 * current balance as a USD fiat holding.
 *
 * Docs: https://docs.mercury.com/
 */

import { ScaniIntegration } from '../base';
import type { MercuryApiService } from '../services/MercuryApiService';
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

export class MercuryIntegration extends ScaniIntegration {
  private readonly apiService: MercuryApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: MercuryApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.apiService = apiService;
  }

  private getToken(credentials?: Record<string, unknown>): string | null {
    const t = (credentials?.apiToken ?? credentials?.apiKey) as string | undefined;
    return t && t.length > 0 ? t : null;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      const token = this.getToken(credentials);
      if (!token) return { accounts: [], total: 0, errors: ['No API token provided'] };

      const accounts = await this.apiService.getAccounts(token);
      const mapped = accounts.map((a) => ({
        externalId: `BANK_${a.id}`,
        name: a.nickname || a.name,
        accountType: a.type === 'checking' ? 'CHECKING' : a.type.toUpperCase(),
        description: `Mercury ${a.name}`,
        metadata: {
          provider: 'mercury',
          accountType: a.type.toUpperCase(),
          mercuryAccountId: a.id,
          accountNumber: a.accountNumber,
          kind: a.kind,
          status: a.status,
        },
        isActive: a.status === 'active',
      }));
      return { accounts: mapped, total: mapped.length };
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
      const token = this.getToken(credentials);
      if (!token) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No API token provided'],
        };
      }

      const mercuryAccountId = accountId.replace(/^BANK_/, '');
      const all = await this.apiService.getAccounts(token);
      const account = all.find((a) => a.id === mercuryAccountId);
      if (!account) {
        return { holdings: [], total: 0, accountId, timestamp: new Date() };
      }

      const holdings: IntegrationHolding[] = [
        {
          symbol: 'USD',
          name: 'US Dollar',
          balance: String(account.currentBalance ?? 0),
          decimals: 2,
          tokenType: 'fiat',
          externalTokenId: `CASH_${account.id}`,
          metadata: {
            accountType: account.type.toUpperCase(),
            availableBalance: account.availableBalance,
            mercuryAccountId: account.id,
            kind: account.kind,
          },
        },
      ];

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
        decimals: 2,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'mercury',
          externalId: holding.externalTokenId,
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    const token = this.getToken(credentials);
    if (!token) return false;
    return await this.apiService.validateToken(token);
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    return { refreshed: false, message: 'API tokens do not expire - no refresh needed' };
  }
}
