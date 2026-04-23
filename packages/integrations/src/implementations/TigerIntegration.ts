/**
 * TigerIntegration - Tiger Brokers (Asia/US)
 *
 * Credentials: `apiKey` holds tiger_id (developer ID); `apiSecret` holds
 * the PEM-encoded RSA private key.
 *
 * Docs: https://quant.itigerup.com/openapi/en/
 */

import { ScaniIntegration } from '../base';
import type { TigerApiService, TigerPosition } from '../services/TigerApiService';
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

function mapSecType(secType?: string): string {
  switch (secType?.toUpperCase()) {
    case 'STK':
    case 'ETF':
    case 'FUT':
    case 'OPT':
    case 'WAR':
      return 'stock';
    case 'CASH':
      return 'fiat';
    case 'CRYPTO':
      return 'crypto';
    default:
      return 'stock';
  }
}

export class TigerIntegration extends ScaniIntegration {
  private readonly apiService: TigerApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: TigerApiService,
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
        return { accounts: [], total: 0, errors: ['No tiger_id or private key provided'] };
      }
      const tigerId = credentials.apiKey as string;
      const privateKey = credentials.apiSecret as string;
      const tigerAccounts = await this.apiService.getAccounts(tigerId, privateKey);

      const accounts = tigerAccounts.map((a) => ({
        externalId: `BROKERAGE_${a.account}`,
        name: `Tiger ${a.account}`,
        accountType: 'BROKERAGE',
        description: `Tiger Brokers account ${a.account}`,
        metadata: {
          provider: 'tiger_brokers',
          accountType: 'BROKERAGE',
          tigerAccount: a.account,
          capability: a.capability,
          status: a.status,
        },
        isActive: true,
      }));

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
      if (!credentials?.apiKey || !credentials?.apiSecret) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No tiger_id or private key provided'],
        };
      }
      const tigerId = credentials.apiKey as string;
      const privateKey = credentials.apiSecret as string;
      const tigerAccount = accountId.replace(/^BROKERAGE_/, '');
      const positions = await this.apiService.getPositions(tigerId, privateKey, tigerAccount);

      const holdings: IntegrationHolding[] = positions.map((p: TigerPosition) => ({
        symbol: p.symbol.toUpperCase(),
        name: p.symbol,
        balance: String(p.quantity ?? 0),
        decimals: 4,
        tokenType: mapSecType(p.sec_type),
        externalTokenId: p.contract_id ?? p.symbol,
        metadata: {
          accountType: 'BROKERAGE',
          currency: p.currency,
          secType: p.sec_type,
          averageCost: p.average_cost,
          marketPrice: p.market_price,
          marketValue: p.market_value,
          unrealizedPnL: p.unrealized_pnl,
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
        decimals: holding.decimals,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'tiger_brokers',
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
    return await this.apiService.validateCredentials(
      credentials.apiKey as string,
      credentials.apiSecret as string
    );
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    return { refreshed: false, message: 'RSA keys do not expire - no refresh needed' };
  }
}
