/**
 * MexcApiService
 *
 * Handles MEXC API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 *
 * MEXC uses HMAC-SHA256 signing (very similar to Binance).
 * Sign: HMAC-SHA256(queryString, secret) appended as `signature` param.
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * MEXC account balance entry
 */
interface MexcBalance {
  asset: string;
  free: string;
  locked: string;
}

/**
 * MEXC API Service
 */
export class MexcApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  /**
   * Receive window for API requests in milliseconds
   */
  private readonly RECV_WINDOW = 5000;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create signed query string for authenticated requests
   * @private
   */
  private createSignedQueryString(apiSecret: string, params: Record<string, unknown> = {}): string {
    const timestamp = Date.now();
    const allParams = {
      timestamp,
      recvWindow: this.RECV_WINDOW,
      ...params,
    };

    // Build query string
    const queryString = Object.entries(allParams)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    // Create HMAC SHA256 signature
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    return `${queryString}&signature=${signature}`;
  }

  /**
   * Validate API Key and Secret by making an account query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const queryString = this.createSignedQueryString(apiSecret);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/api/v3/account?${queryString}`, {
          headers: { 'X-MEXC-APIKEY': apiKey },
        }),
      subKey
    );

    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`MEXC HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  /**
   * Get account balances using API key authentication
   * Returns balances for all assets in the account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; free: string; locked: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const queryString = this.createSignedQueryString(apiSecret);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}/api/v3/account?${queryString}`, {
            headers: {
              'X-MEXC-APIKEY': apiKey,
            },
          }),
        subKey
      );

      if (!response.ok) {
        const error = (await response.json()) as Record<string, unknown>;
        throw new Error(
          `Failed to fetch balances: ${(error.msg as string) || response.statusText}`
        );
      }

      const data = (await response.json()) as Record<string, unknown>;

      // Response structure: { balances: Array<{ asset, free, locked }> }
      if (data.balances && Array.isArray(data.balances)) {
        return data.balances as MexcBalance[];
      }

      return [];
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
