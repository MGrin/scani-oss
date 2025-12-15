/**
 * KrakenApiService
 *
 * Handles Kraken API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 * - Asset information fetching
 */

import crypto from 'node:crypto';
import type { RateLimiter } from '../types';

/**
 * Kraken asset balance
 */
interface KrakenBalance {
  [asset: string]: string;
}

/**
 * Kraken API Service
 * Based on Kraken REST API documentation: https://docs.kraken.com/api/docs/guides/global-intro
 */
export class KrakenApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  /**
   * API version for Kraken
   */
  private readonly API_VERSION = '0';

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create signature for authenticated Kraken API requests
   * Based on: https://docs.kraken.com/api/docs/guides/spot-rest-auth
   * @private
   */
  private createSignature(
    path: string,
    nonce: string,
    postData: string,
    apiSecret: string
  ): string {
    // Decode base64 secret
    const secretBuffer = Buffer.from(apiSecret, 'base64');

    // Create SHA256 hash of nonce + postData
    const hash = crypto.createHash('sha256');
    hash.update(nonce + postData);
    const hashDigest = hash.digest();

    // Create HMAC SHA512
    const hmac = crypto.createHmac('sha512', secretBuffer);
    hmac.update(path);
    hmac.update(hashDigest);

    return hmac.digest('base64');
  }

  /**
   * Validate API Key and Secret by making a balance query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      const nonce = Date.now().toString();
      const path = `/${this.API_VERSION}/private/Balance`;
      const postData = `nonce=${nonce}`;

      const signature = this.createSignature(path, nonce, postData, apiSecret);

      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'API-Key': apiKey,
            'API-Sign': signature,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: postData,
        })
      );

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { error?: string[] };

      // Kraken returns error array - empty means success
      if (data.error && data.error.length > 0) {
        return false;
      }

      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get account balances using API key authentication
   * Returns balances for all assets in the account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; balance: string }>> {
    try {
      const nonce = Date.now().toString();
      const path = `/${this.API_VERSION}/private/Balance`;
      const postData = `nonce=${nonce}`;

      const signature = this.createSignature(path, nonce, postData, apiSecret);

      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'API-Key': apiKey,
            'API-Sign': signature,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: postData,
        })
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        error?: string[];
        result?: KrakenBalance;
      };

      if (data.error && data.error.length > 0) {
        throw new Error(`Kraken API error: ${data.error.join(', ')}`);
      }

      if (!data.result) {
        return [];
      }

      // Convert object to array format
      return Object.entries(data.result).map(([asset, balance]) => ({
        asset,
        balance,
      }));
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
