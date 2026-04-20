/**
 * GateioApiService
 *
 * Handles Gate.io API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 *
 * Gate.io uses HMAC-SHA512 signing with API key + secret.
 * Sign: HMAC-SHA512(method + \n + url + \n + queryString + \n + hashedBody + \n + timestamp, secret)
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Gate.io spot account balance entry
 */
interface GateioSpotBalance {
  currency: string;
  available: string;
  locked: string;
}

/**
 * Gate.io API Service
 */
export class GateioApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create HMAC-SHA512 signature for Gate.io API requests
   * Sign: HMAC-SHA512(method\nurl\nqueryString\nhashedBody\ntimestamp, secret)
   * @private
   */
  private createSignature(
    method: string,
    url: string,
    queryString: string,
    body: string,
    timestamp: string,
    apiSecret: string
  ): string {
    const hashedBody = crypto.createHash('sha512').update(body).digest('hex');
    const preHash = `${method}\n${url}\n${queryString}\n${hashedBody}\n${timestamp}`;
    return crypto.createHmac('sha512', apiSecret).update(preHash).digest('hex');
  }

  /**
   * Build authentication headers for Gate.io API requests
   * @private
   */
  private buildHeaders(
    apiKey: string,
    apiSecret: string,
    method: string,
    url: string,
    queryString: string = '',
    body: string = ''
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.createSignature(method, url, queryString, body, timestamp, apiSecret);

    return {
      KEY: apiKey,
      SIGN: signature,
      Timestamp: timestamp,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Validate API Key and Secret by making a spot accounts query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const url = '/spot/accounts';
    const headers = this.buildHeaders(apiKey, apiSecret, 'GET', url);
    const response = await this.executeWithRateLimit(
      () => fetch(`${this.baseUrl}${url}`, { method: 'GET', headers }),
      subKey
    );

    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gate.io HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Gate.io returned unexpected payload shape (expected array)');
    }
    return true;
  }

  /**
   * Get spot account balances using API key authentication
   * Returns balances for all currencies in the spot account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ currency: string; available: string; locked: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const url = '/spot/accounts';
      const headers = this.buildHeaders(apiKey, apiSecret, 'GET', url);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}${url}`, {
            method: 'GET',
            headers,
          }),
        subKey
      );

      if (!response.ok) {
        const error = (await response.json()) as Record<string, unknown>;
        throw new Error(
          `Failed to fetch balances: ${(error.message as string) || response.statusText}`
        );
      }

      const data = (await response.json()) as unknown;

      // Gate.io returns an array of spot balances
      if (Array.isArray(data)) {
        return (data as GateioSpotBalance[]).map((item) => ({
          currency: item.currency,
          available: item.available,
          locked: item.locked,
        }));
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
