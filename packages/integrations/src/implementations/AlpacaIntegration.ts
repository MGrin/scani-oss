/**
 * AlpacaIntegration - API Key Integration for Alpaca (US stocks + crypto)
 *
 * Emits stock positions via `/v2/positions` plus a cash fiat holding from
 * `/v2/account`. Token types are `stock` / `crypto` / `fiat` — tagged
 * from the Alpaca `asset_class` rather than symbol-based heuristics.
 *
 * Docs: https://docs.alpaca.markets/
 */

import { ScaniIntegration } from '../base';
import type { AlpacaApiService, AlpacaPosition } from '../services/AlpacaApiService';
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

function alpacaTokenType(assetClass: string): string {
  if (assetClass === 'crypto') return 'crypto';
  // us_equity, us_option, etc. → stock
  return 'stock';
}

export class AlpacaIntegration extends ScaniIntegration {
  private readonly apiService: AlpacaApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: AlpacaApiService,
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
      const account = await this.apiService.getAccount(apiKey, apiSecret);

      return {
        accounts: [
          {
            externalId: `BROKERAGE_${account.id}`,
            name: `Alpaca Brokerage (${account.account_number})`,
            accountType: 'BROKERAGE',
            description: 'Alpaca trading account',
            metadata: {
              provider: 'alpaca',
              accountType: 'BROKERAGE',
              accountNumber: account.account_number,
              status: account.status,
              currency: account.currency,
            },
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

      const [account, positions] = await Promise.all([
        this.apiService.getAccount(apiKey, apiSecret),
        this.apiService.getPositions(apiKey, apiSecret),
      ]);

      const holdings: IntegrationHolding[] = positions.map((p: AlpacaPosition) => ({
        symbol: p.symbol.toUpperCase(),
        name: p.symbol,
        balance: p.qty,
        decimals: p.asset_class === 'crypto' ? 8 : 4,
        tokenType: alpacaTokenType(p.asset_class),
        externalTokenId: p.asset_id,
        metadata: {
          accountType: 'BROKERAGE',
          assetClass: p.asset_class,
          exchange: p.exchange,
          avgEntryPrice: p.avg_entry_price,
          marketValue: p.market_value,
          costBasis: p.cost_basis,
          unrealizedPL: p.unrealized_pl,
          currentPrice: p.current_price,
        },
      }));

      if (Number(account.cash) > 0) {
        holdings.push({
          symbol: account.currency.toUpperCase(),
          name: account.currency,
          balance: account.cash,
          decimals: 2,
          tokenType: 'fiat',
          externalTokenId: `CASH_${account.currency}`,
          metadata: {
            accountType: 'BROKERAGE',
            portfolioValue: account.portfolio_value,
            buyingPower: account.buying_power,
            equity: account.equity,
          },
        });
      }

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
          provider: 'alpaca',
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
