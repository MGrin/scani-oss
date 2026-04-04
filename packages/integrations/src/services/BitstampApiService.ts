/**
 * BitstampApiService
 *
 * Handles Bitstamp API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 */

import crypto from 'node:crypto';
import type { RateLimiter } from '../types';

/**
 * Bitstamp balance response
 * Returns an object with keys like `btc_balance`, `usd_balance`, etc.
 */
type BitstampBalanceResponse = Record<string, string>;

/**
 * Bitstamp API Service
 * Based on Bitstamp API documentation: https://www.bitstamp.net/api/
 */
export class BitstampApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create HMAC-SHA256 signature for authenticated Bitstamp API requests
   * Signature = HMAC-SHA256(
   *   "BITSTAMP " + apiKey + method + host + path + query + contentType + nonce + timestamp + version + body,
   *   secret
   * )
   * @private
   */
  private createSignature(
    apiKey: string,
    apiSecret: string,
    method: string,
    host: string,
    path: string,
    query: string,
    contentType: string,
    nonce: string,
    timestamp: string,
    version: string,
    body: string
  ): string {
    const preSign = `BITSTAMP ${apiKey}${method}${host}${path}${query}${contentType}${nonce}${timestamp}${version}${body}`;
    return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
  }

  /**
   * Create authenticated headers for Bitstamp API requests
   * @private
   */
  private createAuthHeaders(
    apiKey: string,
    apiSecret: string,
    method: string,
    path: string,
    body: string = ''
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const host = 'www.bitstamp.net';
    const contentType = method === 'POST' ? 'application/x-www-form-urlencoded' : '';
    const version = 'v2';
    const query = '';

    const signature = this.createSignature(
      apiKey,
      apiSecret,
      method,
      host,
      path,
      query,
      contentType,
      nonce,
      timestamp,
      version,
      body
    );

    const headers: Record<string, string> = {
      'X-Auth': `BITSTAMP ${apiKey}`,
      'X-Auth-Signature': signature,
      'X-Auth-Nonce': nonce,
      'X-Auth-Timestamp': timestamp,
      'X-Auth-Version': version,
    };

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  }

  /**
   * Validate API Key and Secret by making a balance query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      const path = '/api/v2/balance/';
      const headers = this.createAuthHeaders(apiKey, apiSecret, 'POST', path);

      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}/balance/`, {
          method: 'POST',
          headers,
        })
      );

      return response.ok;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get all account balances using API key authentication
   * Returns balances parsed from the `{currency}_balance` response keys
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ currency: string; balance: string }>> {
    try {
      const path = '/api/v2/balance/';
      const headers = this.createAuthHeaders(apiKey, apiSecret, 'POST', path);

      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}/balance/`, {
          method: 'POST',
          headers,
        })
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as BitstampBalanceResponse;

      // Extract currencies from keys matching the pattern `{currency}_balance`
      const balances: Array<{ currency: string; balance: string }> = [];
      const balanceRegex = /^([a-z0-9]+)_balance$/;

      for (const [key, value] of Object.entries(data)) {
        const match = key.match(balanceRegex);
        if (match?.[1] && typeof value === 'string') {
          balances.push({
            currency: match[1],
            balance: value,
          });
        }
      }

      return balances;
    } catch (error) {
      throw new Error(
        `Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Execute function with rate limiting if configured
   */
  private async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn);
    }
    return fn();
  }
}
