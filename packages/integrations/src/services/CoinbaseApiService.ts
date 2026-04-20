/**
 * CoinbaseApiService
 *
 * Handles Coinbase API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Coinbase account data
 */
interface CoinbaseAccount {
  id: string;
  name: string;
  type: string;
  currency: {
    code: string;
    name: string;
  };
  balance: {
    amount: string;
    currency: string;
  };
}

/**
 * Coinbase list accounts response
 */
interface CoinbaseAccountsResponse {
  data: CoinbaseAccount[];
  pagination: {
    next_uri: string | null;
  };
}

/**
 * Coinbase API Service
 * Based on Coinbase API documentation: https://docs.cdp.coinbase.com/coinbase-app/docs/welcome
 */
export class CoinbaseApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  /**
   * API version header value
   */
  private readonly API_VERSION = '2024-01-01';

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create HMAC-SHA256 signature for authenticated Coinbase API requests
   * Signature = HMAC-SHA256(timestamp + method + requestPath + body, secret)
   * @private
   */
  private createSignature(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
    apiSecret: string
  ): string {
    const preSign = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
  }

  /**
   * Create authenticated headers for Coinbase API requests
   * @private
   */
  private createAuthHeaders(
    apiKey: string,
    apiSecret: string,
    method: string,
    requestPath: string,
    body: string = ''
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.createSignature(timestamp, method, requestPath, body, apiSecret);

    return {
      'CB-ACCESS-KEY': apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-VERSION': this.API_VERSION,
    };
  }

  /**
   * Validate API Key and Secret by making an accounts query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const requestPath = '/v2/accounts?limit=1';
    const headers = this.createAuthHeaders(apiKey, apiSecret, 'GET', requestPath);
    const response = await this.executeWithRateLimit(
      () => fetch(`${this.baseUrl}${requestPath}`, { headers }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Coinbase HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  /**
   * Get all account balances using API key authentication
   * Returns balances for all accounts, handling pagination
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<
    Array<{
      currency: string;
      balance: string;
      name: string;
      type: string;
    }>
  > {
    const subKey = credentialBucketKey(apiKey);
    try {
      const allAccounts: CoinbaseAccount[] = [];
      let nextUri: string | null = '/v2/accounts?limit=100';

      while (nextUri) {
        const requestPath = nextUri;
        const headers = this.createAuthHeaders(apiKey, apiSecret, 'GET', requestPath);

        const response = await this.executeWithRateLimit(
          () =>
            fetch(`${this.baseUrl}${requestPath}`, {
              headers,
            }),
          subKey
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as CoinbaseAccountsResponse;

        if (data.data) {
          allAccounts.push(...data.data);
        }

        nextUri = data.pagination?.next_uri || null;
      }

      return allAccounts.map((account) => ({
        currency: account.currency.code,
        balance: account.balance.amount,
        name: account.name,
        type: account.type,
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
