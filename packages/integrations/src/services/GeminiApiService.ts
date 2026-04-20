/**
 * GeminiApiService
 *
 * Handles Gemini API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Gemini balance entry
 */
interface GeminiBalance {
  currency: string;
  amount: string;
  available: string;
  availableForWithdrawal: string;
  type: string;
}

/**
 * Gemini API Service
 * Based on Gemini API documentation: https://docs.gemini.com/rest-api/
 */
export class GeminiApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create HMAC-SHA384 signature for authenticated Gemini API requests
   * Payload JSON → base64 → HMAC-SHA384(base64Payload, secret) → hex
   * @private
   */
  private createSignature(base64Payload: string, apiSecret: string): string {
    return crypto.createHmac('sha384', apiSecret).update(base64Payload).digest('hex');
  }

  /**
   * Create authenticated headers for Gemini API requests
   * @private
   */
  private createAuthHeaders(
    apiKey: string,
    apiSecret: string,
    requestPath: string
  ): Record<string, string> {
    const nonce = Date.now().toString();
    const payload = {
      request: requestPath,
      nonce,
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = this.createSignature(base64Payload, apiSecret);

    return {
      'X-GEMINI-APIKEY': apiKey,
      'X-GEMINI-PAYLOAD': base64Payload,
      'X-GEMINI-SIGNATURE': signature,
      'Content-Type': 'text/plain',
      'Content-Length': '0',
      'Cache-Control': 'no-cache',
    };
  }

  /**
   * Validate API Key and Secret by making a balances query
   * This tests authentication without affecting the account
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const requestPath = '/v1/balances';
    const headers = this.createAuthHeaders(apiKey, apiSecret, requestPath);
    const response = await this.executeWithRateLimit(
      () => fetch(`${this.baseUrl}${requestPath}`, { method: 'POST', headers }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  /**
   * Get all account balances using API key authentication
   * Returns balances for all currencies in the account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ currency: string; amount: string; type: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const requestPath = '/v1/balances';
      const headers = this.createAuthHeaders(apiKey, apiSecret, requestPath);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}${requestPath}`, {
            method: 'POST',
            headers,
          }),
        subKey
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as GeminiBalance[];

      if (!Array.isArray(data)) {
        return [];
      }

      return data.map((b) => ({
        currency: b.currency,
        amount: b.amount,
        type: b.type,
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
