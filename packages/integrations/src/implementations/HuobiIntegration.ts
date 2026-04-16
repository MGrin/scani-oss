/**
 * HuobiIntegration - API Key Integration for Huobi (HTX) Exchange
 */

import { ScaniIntegration } from '../base';
import type { HuobiApiService } from '../services/HuobiApiService';
import type {
  AuthConfig,
  FetchAccountsResult,
  FetchHoldingsResult,
  ICredentialManager,
  IntegrationHolding,
  IntegrationStatus,
  IWalletManager,
  RateLimiter,
  TokenMappingResult,
} from '../types';

export class HuobiIntegration extends ScaniIntegration {
  private readonly huobiService: HuobiApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    huobiService: HuobiApiService,
    rateLimiter?: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.huobiService = huobiService;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    const apiKey = credentials?.apiKey as string;
    const apiSecret = credentials?.apiSecret as string;
    if (!apiKey || !apiSecret) {
      return { accounts: [], total: 0, errors: ['Missing API credentials'] };
    }

    try {
      const accounts = await this.huobiService.getAccounts(apiKey, apiSecret);
      return {
        accounts: accounts
          .filter((a) => a.state === 'working')
          .map((a) => ({
            externalId: `huobi-${a.id}`,
            name: `Huobi ${a.type.charAt(0).toUpperCase() + a.type.slice(1)}`,
            accountType: a.type === 'spot' ? 'SPOT' : a.type.toUpperCase(),
            metadata: { huobiAccountId: a.id },
          })),
        total: accounts.length,
      };
    } catch (error) {
      return {
        accounts: [],
        total: 0,
        errors: [`Failed to fetch accounts: ${error instanceof Error ? error.message : 'Unknown'}`],
      };
    }
  }

  async fetchHoldings(
    accountId: string,
    credentials?: Record<string, unknown>
  ): Promise<FetchHoldingsResult> {
    const apiKey = credentials?.apiKey as string;
    const apiSecret = credentials?.apiSecret as string;
    if (!apiKey || !apiSecret) {
      return {
        holdings: [],
        total: 0,
        accountId,
        timestamp: new Date(),
        errors: ['Missing credentials'],
      };
    }

    // Extract Huobi account ID from our external ID format
    const huobiAccountId = Number.parseInt(accountId.replace('huobi-', ''), 10);
    if (Number.isNaN(huobiAccountId)) {
      return {
        holdings: [],
        total: 0,
        accountId,
        timestamp: new Date(),
        errors: ['Invalid account ID'],
      };
    }

    try {
      const balances = await this.huobiService.getBalance(apiKey, apiSecret, huobiAccountId);

      // Aggregate trade + frozen balances per currency
      const aggregated = new Map<string, number>();
      for (const b of balances) {
        const amount = Number.parseFloat(b.balance);
        if (amount > 0 && (b.type === 'trade' || b.type === 'frozen')) {
          aggregated.set(b.currency, (aggregated.get(b.currency) || 0) + amount);
        }
      }

      const holdings: IntegrationHolding[] = [];
      for (const [currency, balance] of aggregated) {
        holdings.push({
          symbol: currency.toUpperCase(),
          name: currency.toUpperCase(),
          balance: balance.toString(),
          decimals: 8,
          tokenType: 'crypto',
          metadata: { exchange: 'huobi' },
        });
      }

      return { holdings, total: holdings.length, accountId, timestamp: new Date() };
    } catch (error) {
      return {
        holdings: [],
        total: 0,
        accountId,
        timestamp: new Date(),
        errors: [`Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown'}`],
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
        iconUrl: null,
        providerMetadata: JSON.stringify({ source: 'huobi', ...(holding.metadata || {}) }),
        isScamProbability: 0,
      },
      isNew: true,
      confidence: 0.8,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    const apiKey = credentials?.apiKey as string;
    const apiSecret = credentials?.apiSecret as string;
    if (!apiKey || !apiSecret) return false;
    return this.huobiService.validateCredentials(apiKey, apiSecret);
  }

  async checkHealth(): Promise<IntegrationStatus> {
    return { isHealthy: true, details: { exchange: 'huobi' } };
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    return {};
  }
}
