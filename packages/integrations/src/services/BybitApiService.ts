/**
 * BybitApiService
 *
 * Handles Bybit API communications for API Key authentication:
 * - Account balance retrieval (Unified account)
 * - API key validation via signed requests
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Bybit coin balance
 */
interface BybitCoin {
  coin: string;
  walletBalance: string;
  usdValue: string;
  equity?: string;
  availableToWithdraw?: string;
  unrealisedPnl?: string;
}

/**
 * Bybit wallet balance response
 */
interface BybitWalletBalanceResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<{
      accountType: string;
      coin: BybitCoin[];
      totalEquity?: string;
      totalWalletBalance?: string;
    }>;
  };
}

/**
 * Bybit API Service
 * Based on Bybit V5 API documentation: https://bybit-exchange.github.io/docs/v5/intro
 */
export class BybitApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  /**
   * Receive window for API requests in milliseconds
   */
  private readonly RECV_WINDOW = '5000';

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create HMAC-SHA256 signature for authenticated Bybit API requests
   * Signature = HMAC_SHA256(timestamp + apiKey + recvWindow + queryString, apiSecret)
   * @private
   */
  private createSignature(
    timestamp: string,
    apiKey: string,
    apiSecret: string,
    queryString: string
  ): string {
    const preSign = timestamp + apiKey + this.RECV_WINDOW + queryString;
    return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
  }

  /**
   * Create authenticated headers for Bybit API requests
   * @private
   */
  private createAuthHeaders(
    apiKey: string,
    apiSecret: string,
    queryString: string
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const signature = this.createSignature(timestamp, apiKey, apiSecret, queryString);

    return {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': this.RECV_WINDOW,
    };
  }

  /**
   * Validate API Key and Secret by making a wallet balance query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const queryString = 'accountType=UNIFIED';
    const headers = this.createAuthHeaders(apiKey, apiSecret, queryString);
    const response = await this.executeWithRateLimit(
      () => fetch(`${this.baseUrl}/v5/account/wallet-balance?${queryString}`, { headers }),
      subKey
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Bybit HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as BybitWalletBalanceResponse & { retMsg?: string };
    if (data.retCode !== 0) {
      throw new Error(
        `Bybit rejected request: retCode ${data.retCode}${data.retMsg ? ` (${data.retMsg})` : ''}`
      );
    }
    return true;
  }

  /**
   * Get unified account balances using API key authentication
   * Returns balances for all coins in the unified account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ coin: string; walletBalance: string; usdValue: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const queryString = 'accountType=UNIFIED';
      const headers = this.createAuthHeaders(apiKey, apiSecret, queryString);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}/v5/account/wallet-balance?${queryString}`, {
            headers,
          }),
        subKey
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as BybitWalletBalanceResponse;

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg}`);
      }

      if (!data.result?.list?.[0]?.coin) {
        return [];
      }

      return data.result.list[0].coin.map((c) => ({
        coin: c.coin,
        walletBalance: c.walletBalance,
        usdValue: c.usdValue,
      }));
    } catch (error) {
      throw new Error(
        `Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Execute function with rate limiting if configured. `subKey`
   * partitions the provider-wide bucket by credential hash.
   */
  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
