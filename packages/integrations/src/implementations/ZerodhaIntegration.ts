/**
 * ZerodhaIntegration - Kite Connect (India)
 *
 * Credentials blob (all required):
 *   apiKey     — Kite Connect developer api_key
 *   apiSecret  — Kite Connect developer api_secret
 *   userId     — Zerodha client ID (e.g. "AB1234")
 *   password   — Zerodha account login password
 *   totpSecret — base32 TOTP secret from Zerodha 2FA setup
 *
 * Optional: `accessToken` + `accessTokenIssuedAt` — a cached fresh
 * access_token we derived on a previous call. We try that first on each
 * sync; if it's stale (Kite expires them ~06:00 IST) or missing, we run
 * the full Kite login flow to mint a new one.
 *
 * Docs: https://kite.trade/docs/connect/v3/
 */

import { ScaniIntegration } from '../base';
import type { ZerodhaApiService, ZerodhaLoginCredentials } from '../services/ZerodhaApiService';
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

function extractCreds(credentials?: Record<string, unknown>): ZerodhaLoginCredentials | null {
  const apiKey = credentials?.apiKey as string | undefined;
  const apiSecret = credentials?.apiSecret as string | undefined;
  const userId = credentials?.userId as string | undefined;
  const password = credentials?.password as string | undefined;
  const totpSecret = credentials?.totpSecret as string | undefined;
  if (!apiKey || !apiSecret || !userId || !password || !totpSecret) return null;
  return { apiKey, apiSecret, userId, password, totpSecret };
}

export class ZerodhaIntegration extends ScaniIntegration {
  private readonly apiService: ZerodhaApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    apiService: ZerodhaApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.apiService = apiService;
  }

  /**
   * Run an operation with a fresh-enough access_token. If the read
   * returns 403 we invalidate the cached token and retry exactly once
   * with a freshly-minted one — that covers the 06:00 IST daily expiry
   * transparently.
   */
  private async withAccessToken<T>(
    creds: ZerodhaLoginCredentials,
    operation: (accessToken: string) => Promise<T>
  ): Promise<T> {
    const token = await this.apiService.getOrRefreshAccessToken(creds);
    try {
      return await operation(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 403') || msg.includes('TokenException')) {
        this.apiService.invalidateToken(creds);
        const fresh = await this.apiService.getOrRefreshAccessToken(creds, true);
        return operation(fresh);
      }
      throw err;
    }
  }

  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      const creds = extractCreds(credentials);
      if (!creds) {
        return {
          accounts: [],
          total: 0,
          errors: [
            'Missing Kite credentials — need api_key, api_secret, Kite user_id, password, and TOTP secret',
          ],
        };
      }
      // Prove we can mint a token before declaring the account exists.
      await this.apiService.getOrRefreshAccessToken(creds);

      return {
        accounts: [
          {
            externalId: `BROKERAGE_zerodha-${creds.userId.toLowerCase()}`,
            name: `Zerodha Kite (${creds.userId})`,
            accountType: 'BROKERAGE',
            description: 'Zerodha Kite Connect trading account',
            metadata: {
              provider: 'zerodha',
              accountType: 'BROKERAGE',
              kiteUserId: creds.userId,
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
      const creds = extractCreds(credentials);
      if (!creds) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['Missing Kite credentials'],
        };
      }

      const [positions, margins] = await this.withAccessToken(creds, async (token) => {
        return Promise.all([
          this.apiService.getHoldings(creds.apiKey, token),
          this.apiService.getMargins(creds.apiKey, token).catch(() => null),
        ]);
      });

      const holdings: IntegrationHolding[] = positions.map((p) => ({
        symbol: p.tradingsymbol.toUpperCase(),
        name: p.tradingsymbol,
        balance: String(p.quantity ?? 0),
        decimals: 4,
        tokenType: 'stock',
        externalTokenId: p.isin ?? String(p.instrument_token),
        metadata: {
          accountType: 'BROKERAGE',
          exchange: p.exchange,
          isin: p.isin,
          instrumentToken: p.instrument_token,
          averagePrice: p.average_price,
          lastPrice: p.last_price,
          pnl: p.pnl,
          product: p.product,
        },
      }));

      const cashAvailable = margins?.equity?.available?.cash ?? 0;
      if (cashAvailable > 0) {
        holdings.push({
          symbol: 'INR',
          name: 'Indian Rupee',
          balance: String(cashAvailable),
          decimals: 2,
          tokenType: 'fiat',
          externalTokenId: 'CASH_INR',
          metadata: {
            accountType: 'BROKERAGE',
            netEquity: margins?.equity?.net,
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
          provider: 'zerodha',
          externalId: holding.externalTokenId,
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    const creds = extractCreds(credentials);
    if (!creds) return false;
    try {
      await this.apiService.refreshAccessToken(creds);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('TOTP') ||
        msg.includes('2FA') ||
        msg.includes('request_token') ||
        msg.includes('HTTP 40')
      ) {
        return false;
      }
      throw err;
    }
  }

  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    // Our "refresh" is self-contained in ensureAccessToken — no
    // provider-level refresh_token exchange exists.
    return {
      refreshed: false,
      message:
        'Kite access_token is auto-refreshed on each sync using the stored user_id + password + TOTP secret.',
    };
  }
}
