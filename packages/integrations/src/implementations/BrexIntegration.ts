/**
 * BrexIntegration - Brex business banking (US)
 *
 * Single bearer-token auth. Reads Brex Cash accounts only (card spending
 * is not a balance).
 *
 * Docs: https://developer.brex.com/
 *
 * Note: Brex user tokens expire after 30 days of non-use; the 15-min
 * cron sync keeps them alive.
 */

import { ScaniIntegration } from '../base';
import type { BrexApiService } from '../services/BrexApiService';
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

/** Brex money amounts are integer cents. Convert to a decimal string. */
function centsToAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

export class BrexIntegration extends ScaniIntegration {
  private readonly apiService: BrexApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: BrexApiService,
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

      const cashAccounts = await this.apiService.getCashAccounts(token);
      const mapped = cashAccounts.map((a) => ({
        externalId: `CASH_${a.id}`,
        name: a.name,
        accountType: 'CASH',
        description: `Brex Cash ${a.name}`,
        metadata: {
          provider: 'brex',
          accountType: 'CASH',
          brexAccountId: a.id,
          status: a.status,
          primary: a.primary,
          accountNumber: a.account_number,
        },
        isActive: a.status === 'ACTIVE',
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

      const brexAccountId = accountId.replace(/^CASH_/, '');
      const all = await this.apiService.getCashAccounts(token);
      const account = all.find((a) => a.id === brexAccountId);
      if (!account) {
        return { holdings: [], total: 0, accountId, timestamp: new Date() };
      }

      const holdings: IntegrationHolding[] = [
        {
          symbol: account.current_balance.currency.toUpperCase(),
          name: account.current_balance.currency,
          balance: centsToAmount(account.current_balance.amount),
          decimals: 2,
          tokenType: 'fiat',
          externalTokenId: `CASH_${account.id}`,
          metadata: {
            accountType: 'CASH',
            availableBalance: centsToAmount(account.available_balance.amount),
            brexAccountId: account.id,
            accountName: account.name,
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
          provider: 'brex',
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
    return {
      refreshed: false,
      message: 'Brex user tokens expire only after 30 days of non-use - no refresh needed',
    };
  }
}
