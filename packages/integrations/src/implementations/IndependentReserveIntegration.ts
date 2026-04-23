/**
 * IndependentReserveIntegration - API Key Integration for Independent Reserve
 *
 * Handles Independent Reserve accounts using API Key authentication.
 * One signed call to GetAccounts returns every currency sub-account with
 * its current AvailableBalance, which we collapse into a single synthetic
 * "Trading Account" whose holdings are the per-currency balances.
 *
 * Docs: https://www.independentreserve.com/features/api
 */

import { ScaniIntegration } from '../base';
import type { IndependentReserveApiService } from '../services/IndependentReserveApiService';
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

/**
 * Independent Reserve uses `Xbt` for Bitcoin; other codes are just
 * mixed-case forms of the standard ticker. Normalise to the symbols we
 * already use elsewhere in the system.
 */
function normaliseSymbol(currencyCode: string): string {
  const upper = currencyCode.toUpperCase();
  if (upper === 'XBT') return 'BTC';
  return upper;
}

export class IndependentReserveIntegration extends ScaniIntegration {
  private readonly apiService: IndependentReserveApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: IndependentReserveApiService,
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
        return {
          accounts: [],
          total: 0,
          errors: ['No API Key or Secret provided'],
        };
      }

      const apiKey = credentials.apiKey as string;
      const apiSecret = credentials.apiSecret as string;
      const isValid = await this.validateCredentials({ apiKey, apiSecret });
      if (!isValid) {
        return {
          accounts: [],
          total: 0,
          errors: ['Invalid API Key or Secret'],
        };
      }

      // IR returns one sub-account per currency. We collapse to a single
      // logical trading account and expose each currency as a holding —
      // same shape as BitstampIntegration.
      const accounts = [
        {
          externalId: 'TRADING_independent-reserve-api-account',
          name: 'Independent Reserve Trading Account',
          accountType: 'TRADING',
          description: 'Independent Reserve Trading Account',
          metadata: {
            provider: 'independent_reserve',
            accountType: 'TRADING',
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

      const rows = await this.apiService.getAccounts(apiKey, apiSecret);

      const holdings: IntegrationHolding[] = rows.map((row) => {
        const symbol = normaliseSymbol(row.CurrencyCode);
        return {
          symbol,
          name: symbol,
          // IR returns balance as a JSON number. Convert via String() so
          // we don't lose precision through Number.toString quirks — the
          // downstream Decimal.js consumer handles either form.
          balance: String(row.AvailableBalance ?? 0),
          decimals: 8,
          tokenType: detectTokenType(symbol),
          externalTokenId: row.CurrencyCode,
          metadata: {
            accountType: 'TRADING',
            accountGuid: row.AccountGuid,
            accountStatus: row.AccountStatus,
            totalBalance: row.TotalBalance,
            originalCurrencyCode: row.CurrencyCode,
          },
        };
      });

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
          provider: 'independent_reserve',
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
    if (!credentials?.apiKey || !credentials?.apiSecret) {
      return false;
    }

    const apiKey = credentials.apiKey as string;
    const apiSecret = credentials.apiSecret as string;
    return await this.apiService.validateApiKey(apiKey, apiSecret);
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    return {
      refreshed: false,
      message: 'API keys do not expire - no refresh needed',
    };
  }
}
