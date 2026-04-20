/**
 * BitgetApiService
 *
 * Handles Bitget API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 *
 * Note: Bitget requires a passphrase in addition to apiKey and apiSecret
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Bitget asset entry
 */
interface BitgetAsset {
  coin: string;
  available: string;
  frozen: string;
  locked: string;
}

/**
 * Bitget spot assets response
 */
interface BitgetAssetsResponse {
  code: string;
  msg: string;
  data: BitgetAsset[];
}

/**
 * Bitget API Service
 * Based on Bitget API documentation: https://www.bitget.com/api-doc/
 */
export class BitgetApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create signature for authenticated Bitget API requests
   * Signature = Base64(HMAC-SHA256(timestamp + method + requestPath + body, secretKey))
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
    return crypto.createHmac('sha256', apiSecret).update(preSign).digest('base64');
  }

  /**
   * Create authenticated headers for Bitget API requests
   * @private
   */
  private createAuthHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    method: string,
    requestPath: string,
    body: string = ''
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const signature = this.createSignature(timestamp, method, requestPath, body, apiSecret);

    return {
      'ACCESS-KEY': apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Validate API Key, Secret, and Passphrase by making an assets query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string, passphrase: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const requestPath = '/api/v2/spot/account/assets';
    const headers = this.createAuthHeaders(apiKey, apiSecret, passphrase, 'GET', requestPath);
    const response = await this.executeWithRateLimit(
      () => fetch(`${this.baseUrl}${requestPath}`, { headers }),
      subKey
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Bitget HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as BitgetAssetsResponse & { msg?: string };
    if (data.code !== '00000') {
      throw new Error(`Bitget rejected request: ${data.code}${data.msg ? ` ${data.msg}` : ''}`);
    }
    return true;
  }

  /**
   * Get spot account balances using API key authentication
   * Returns balances for all coins in the spot account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string,
    passphrase: string
  ): Promise<Array<{ coin: string; available: string; frozen: string; locked: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const requestPath = '/api/v2/spot/account/assets';
      const headers = this.createAuthHeaders(apiKey, apiSecret, passphrase, 'GET', requestPath);

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

      const data = (await response.json()) as BitgetAssetsResponse;

      if (data.code !== '00000') {
        throw new Error(`Bitget API error: ${data.msg}`);
      }

      if (!data.data) {
        return [];
      }

      return data.data.map((a) => ({
        coin: a.coin,
        available: a.available,
        frozen: a.frozen,
        locked: a.locked,
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
