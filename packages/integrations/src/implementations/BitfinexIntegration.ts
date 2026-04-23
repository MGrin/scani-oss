/**
 * BitfinexIntegration - API Key Integration for Bitfinex
 *
 * Docs: https://docs.bitfinex.com/docs/rest-auth
 *
 * Bitfinex exposes three wallet types per user (exchange / margin /
 * funding). We treat each type that actually holds a balance as its own
 * sub-account, preserving wallet-level visibility in the UI.
 */

import { ScaniIntegration } from '../base';
import type { BitfinexApiService } from '../services/BitfinexApiService';
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
 * Bitfinex uses `UST` for USDT, `UDC` for USDC, etc. Strip any leading
 * `t`/`f` market-data prefix and map the known aliases.
 */
function normaliseSymbol(currency: string): string {
  const upper = currency.toUpperCase();
  switch (upper) {
    case 'UST':
      return 'USDT';
    case 'UDC':
      return 'USDC';
    default:
      return upper;
  }
}

export class BitfinexIntegration extends ScaniIntegration {
  private readonly apiService: BitfinexApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: BitfinexApiService,
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

      const wallets = await this.apiService.getWallets(apiKey, apiSecret);
      const walletTypes = Array.from(new Set(wallets.map((row) => row[0])));
      const accounts = walletTypes.length
        ? walletTypes.map((walletType) => ({
            externalId: `${walletType.toUpperCase()}_bitfinex-${walletType}`,
            name: `Bitfinex ${walletType.charAt(0).toUpperCase() + walletType.slice(1)} Wallet`,
            accountType: walletType.toUpperCase(),
            description: `Bitfinex ${walletType} wallet`,
            metadata: { provider: 'bitfinex', walletType },
            isActive: true,
          }))
        : [
            {
              externalId: 'TRADING_bitfinex-exchange',
              name: 'Bitfinex Exchange Wallet',
              accountType: 'EXCHANGE',
              description: 'Bitfinex exchange wallet',
              metadata: { provider: 'bitfinex', walletType: 'exchange' },
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

      const wallets = await this.apiService.getWallets(apiKey, apiSecret);

      // accountId encodes the wallet type (exchange / margin / funding)
      // as its uppercase prefix — see fetchAccounts. We only return
      // holdings for the matching wallet type.
      const [prefix] = accountId.split('_');
      const walletType = prefix?.toLowerCase() ?? 'exchange';

      const rows = wallets.filter(
        (row) => row[0].toLowerCase() === walletType && Number(row[2]) !== 0
      );

      const holdings: IntegrationHolding[] = rows.map((row) => {
        const symbol = normaliseSymbol(row[1]);
        return {
          symbol,
          name: symbol,
          balance: String(row[2]),
          decimals: 8,
          tokenType: detectTokenType(symbol),
          externalTokenId: row[1],
          metadata: {
            accountType: walletType.toUpperCase(),
            walletType,
            availableBalance: row[4],
            unsettledInterest: row[3],
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
        decimals: 8,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'bitfinex',
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
