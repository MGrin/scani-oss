/**
 * KucoinApiService
 *
 * Handles KuCoin API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 *
 * KuCoin uses HMAC-SHA256 signing with API key + secret + passphrase.
 * The passphrase is also HMAC-SHA256 signed with the secret (API Key Version 2).
 */

import crypto from 'node:crypto';
import type { RateLimiter } from '../types';

/**
 * KuCoin account balance entry
 */
interface KucoinAccount {
  id: string;
  currency: string;
  type: string;
  balance: string;
  available: string;
  holds: string;
}

/**
 * KuCoin API Service
 */
export class KucoinApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create HMAC-SHA256 signature for KuCoin API requests
   * Sign: HMAC-SHA256(timestamp + method + endpoint + body, secret) -> base64
   * @private
   */
  private createSignature(
    timestamp: string,
    method: string,
    endpoint: string,
    body: string,
    apiSecret: string
  ): string {
    const preHash = timestamp + method + endpoint + body;
    return crypto.createHmac('sha256', apiSecret).update(preHash).digest('base64');
  }

  /**
   * Sign the passphrase with HMAC-SHA256 (API Key Version 2)
   * @private
   */
  private signPassphrase(passphrase: string, apiSecret: string): string {
    return crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');
  }

  /**
   * Build authentication headers for KuCoin API requests
   * @private
   */
  private buildHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    method: string,
    endpoint: string,
    body: string = ''
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const signature = this.createSignature(timestamp, method, endpoint, body, apiSecret);
    const signedPassphrase = this.signPassphrase(passphrase, apiSecret);

    return {
      'KC-API-KEY': apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': signedPassphrase,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Validate API Key, Secret, and Passphrase by making an accounts query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string, passphrase: string): Promise<boolean> {
    try {
      const endpoint = '/api/v1/accounts';
      const headers = this.buildHeaders(apiKey, apiSecret, passphrase, 'GET', endpoint);

      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}${endpoint}`, {
          method: 'GET',
          headers,
        })
      );

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { code?: string };

      // KuCoin returns code "200000" for success
      return data.code === '200000';
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get account balances using API key authentication
   * Returns balances for all accounts (main, trade, margin)
   */
  async getBalances(
    apiKey: string,
    apiSecret: string,
    passphrase: string
  ): Promise<Array<{ currency: string; balance: string; type: string }>> {
    try {
      const endpoint = '/api/v1/accounts';
      const headers = this.buildHeaders(apiKey, apiSecret, passphrase, 'GET', endpoint);

      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}${endpoint}`, {
          method: 'GET',
          headers,
        })
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        code?: string;
        msg?: string;
        data?: KucoinAccount[];
      };

      if (data.code !== '200000') {
        throw new Error(`KuCoin API error: ${data.msg || data.code}`);
      }

      if (!data.data || !Array.isArray(data.data)) {
        return [];
      }

      return data.data.map((account) => ({
        currency: account.currency,
        balance: account.balance,
        type: account.type,
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
