/**
 * OkxApiService
 *
 * Handles OKX API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 *
 * Note: OKX requires a passphrase in addition to apiKey and apiSecret
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * OKX balance detail
 */
interface OkxBalanceDetail {
  ccy: string;
  cashBal: string;
  eqUsd: string;
  availBal?: string;
  frozenBal?: string;
  upl?: string;
}

/**
 * OKX balance response
 */
interface OkxBalanceResponse {
  code: string;
  msg: string;
  data: Array<{
    totalEq: string;
    details: OkxBalanceDetail[];
  }>;
}

/**
 * OKX API Service
 * Based on OKX V5 API documentation: https://www.okx.com/docs-v5/en/
 */
export class OkxApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create signature for authenticated OKX API requests
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
   * Create authenticated headers for OKX API requests
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
    const timestamp = new Date().toISOString();
    const signature = this.createSignature(timestamp, method, requestPath, body, apiSecret);

    return {
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': passphrase,
    };
  }

  /**
   * Validate API Key, Secret, and Passphrase by making a balance query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string, passphrase: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const requestPath = '/api/v5/account/balance';
    const headers = this.createAuthHeaders(apiKey, apiSecret, passphrase, 'GET', requestPath);
    const response = await this.executeWithRateLimit(
      () => fetch(`${this.baseUrl}${requestPath}`, { headers }),
      subKey
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OKX HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as OkxBalanceResponse & { msg?: string };
    if (data.code !== '0') {
      throw new Error(`OKX rejected request: ${data.code}${data.msg ? ` ${data.msg}` : ''}`);
    }
    return true;
  }

  /**
   * Get account balances using API key authentication
   * Returns balances for all currencies in the account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string,
    passphrase: string
  ): Promise<Array<{ ccy: string; cashBal: string; eqUsd: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const requestPath = '/api/v5/account/balance';
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

      const data = (await response.json()) as OkxBalanceResponse;

      if (data.code !== '0') {
        throw new Error(`OKX API error: ${data.msg}`);
      }

      if (!data.data?.[0]?.details) {
        return [];
      }

      return data.data[0].details.map((d) => ({
        ccy: d.ccy,
        cashBal: d.cashBal,
        eqUsd: d.eqUsd,
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
