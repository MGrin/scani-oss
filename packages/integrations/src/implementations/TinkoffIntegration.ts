/**
 * TinkoffIntegration - API Key Integration for Tinkoff / T-Invest (Russia)
 *
 * Single bearer token credential. Stored via the `apiKey` slot in our
 * credentials blob to keep the standard router+UI flow; the apiSecret
 * slot is ignored.
 *
 * Docs: https://tinkoff.github.io/investAPI/
 *
 * Compliance: see TinkoffApiService header.
 */

import { ScaniIntegration } from '../base';
import {
  type TinkoffApiService,
  type TinkoffPortfolioPosition,
  tinkoffQuotationToString,
} from '../services/TinkoffApiService';
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

function mapInstrumentType(instrumentType: string): string {
  switch (instrumentType) {
    case 'share':
    case 'etf':
    case 'bond':
    case 'future':
    case 'option':
      return 'stock';
    case 'currency':
      return 'fiat';
    case 'crypto':
      return 'crypto';
    default:
      return 'stock';
  }
}

export class TinkoffIntegration extends ScaniIntegration {
  private readonly apiService: TinkoffApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: TinkoffApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.apiService = apiService;
  }

  private getToken(credentials?: Record<string, unknown>): string | null {
    const token = (credentials?.apiToken ?? credentials?.apiKey) as string | undefined;
    return token && token.length > 0 ? token : null;
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      const token = this.getToken(credentials);
      if (!token) {
        return { accounts: [], total: 0, errors: ['No API token provided'] };
      }
      const accounts = await this.apiService.getAccounts(token);
      const mapped = accounts
        .filter((a) => a.accessLevel !== 'ACCOUNT_ACCESS_LEVEL_NO_ACCESS')
        .map((a) => ({
          externalId: `BROKERAGE_${a.id}`,
          name: a.name || `Tinkoff ${a.type}`,
          accountType: 'BROKERAGE',
          description: `Tinkoff ${a.type} account`,
          metadata: {
            provider: 'tinkoff',
            accountType: 'BROKERAGE',
            tinkoffType: a.type,
            accessLevel: a.accessLevel,
            status: a.status,
          },
          isActive: true,
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

      // accountId encodes the Tinkoff account ID after the
      // `BROKERAGE_` prefix established in fetchAccounts.
      const tinkoffAccountId = accountId.replace(/^BROKERAGE_/, '');
      const portfolio = await this.apiService.getPortfolio(token, tinkoffAccountId);

      const holdings: IntegrationHolding[] = portfolio.positions.map(
        (p: TinkoffPortfolioPosition) => {
          const quantity = tinkoffQuotationToString(p.quantity);
          const symbol = p.ticker?.toUpperCase() || p.figi.toUpperCase();
          return {
            symbol,
            name: symbol,
            balance: quantity,
            decimals: p.instrumentType === 'currency' ? 2 : 4,
            tokenType: mapInstrumentType(p.instrumentType),
            externalTokenId: p.figi,
            metadata: {
              accountType: 'BROKERAGE',
              figi: p.figi,
              instrumentType: p.instrumentType,
              instrumentUid: p.instrumentUid,
              averagePositionPrice: p.averagePositionPrice
                ? {
                    currency: p.averagePositionPrice.currency,
                    value: tinkoffQuotationToString(p.averagePositionPrice),
                  }
                : undefined,
              currentPrice: p.currentPrice
                ? {
                    currency: p.currentPrice.currency,
                    value: tinkoffQuotationToString(p.currentPrice),
                  }
                : undefined,
              blocked: p.blocked,
            },
          };
        }
      );

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
          provider: 'tinkoff',
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
