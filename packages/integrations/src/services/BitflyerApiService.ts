/**
 * BitflyerApiService
 *
 * bitFlyer Lightning API authenticated endpoints.
 * - GET /v1/me/getbalance → balances per currency
 * - HMAC-SHA256 signed, hex-encoded
 * - Signed string: timestamp + method + path + body
 *
 * Docs: https://lightning.bitflyer.com/docs?lang=en
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface BitflyerBalance {
  currency_code: string;
  amount: number;
  available: number;
}

export class BitflyerApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  private createSignature(
    apiSecret: string,
    timestamp: string,
    method: string,
    path: string,
    body: string
  ): string {
    const message = `${timestamp}${method}${path}${body}`;
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    apiSecret: string,
    body: string = ''
  ): Promise<T> {
    const timestamp = Date.now().toString();
    const signature = this.createSignature(apiSecret, timestamp, method, path, body);

    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'ACCESS-KEY': apiKey,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-SIGN': signature,
            'Content-Type': 'application/json',
          },
          body: body || undefined,
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`bitFlyer HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const timestamp = Date.now().toString();
    const path = '/v1/me/getbalance';
    const signature = this.createSignature(apiSecret, timestamp, 'GET', path, '');
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            'ACCESS-KEY': apiKey,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-SIGN': signature,
          },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`bitFlyer HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  async getBalances(apiKey: string, apiSecret: string): Promise<BitflyerBalance[]> {
    return this.signedRequest<BitflyerBalance[]>('GET', '/v1/me/getbalance', apiKey, apiSecret);
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
