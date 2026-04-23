/**
 * BtcMarketsApiService
 *
 * Handles BTC Markets v3 API communications for API Key authentication:
 * - GET /v3/accounts/me/balances → list of balances per asset
 * - HMAC-SHA512 signed, base64-encoded
 *
 * Docs: https://docs.btcmarkets.net/
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface BtcMarketsBalance {
  assetName: string;
  balance: string;
  available: string;
  locked: string;
}

export class BtcMarketsApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * BTC Markets signature per the official python client:
   *   stringToSign = path + "\n" + timestamp + "\n" + body
   *   signature    = base64(HMAC-SHA512(stringToSign, base64Decode(apiSecret)))
   *
   * For GET the body is empty, which keeps the trailing newline after the
   * timestamp. The HTTP method is NOT part of the signed string — a common
   * pitfall if you copy patterns from Bitstamp or Coinbase.
   *
   * Source: https://github.com/BTCMarkets/api-client-python/blob/master/btcmarkets.py
   */
  private createSignature(
    apiSecret: string,
    path: string,
    timestamp: string,
    body: string
  ): string {
    const message = `${path}\n${timestamp}\n${body}`;
    const secretBuffer = Buffer.from(apiSecret, 'base64');
    return crypto.createHmac('sha512', secretBuffer).update(message).digest('base64');
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    apiSecret: string,
    body: string = ''
  ): Promise<T> {
    const timestamp = Date.now().toString();
    const signature = this.createSignature(apiSecret, path, timestamp, body);

    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'BM-AUTH-APIKEY': apiKey,
            'BM-AUTH-TIMESTAMP': timestamp,
            'BM-AUTH-SIGNATURE': signature,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body || undefined,
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const snippet = text ? `: ${text.slice(0, 200)}` : '';
      throw new Error(`BTC Markets HTTP ${response.status}${snippet}`);
    }
    return (await response.json()) as T;
  }

  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      // Treat base64-decode failure as "bad secret format" so the UI
      // surfaces something more useful than a fetch-level error.
      if (Buffer.from(apiSecret, 'base64').length === 0) return false;
    } catch {
      return false;
    }

    const timestamp = Date.now().toString();
    const path = '/v3/accounts/me/balances';
    const signature = this.createSignature(apiSecret, path, timestamp, '');
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            'BM-AUTH-APIKEY': apiKey,
            'BM-AUTH-TIMESTAMP': timestamp,
            'BM-AUTH-SIGNATURE': signature,
          },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `BTC Markets HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      );
    }
    return true;
  }

  async getBalances(apiKey: string, apiSecret: string): Promise<BtcMarketsBalance[]> {
    return this.signedRequest<BtcMarketsBalance[]>(
      'GET',
      '/v3/accounts/me/balances',
      apiKey,
      apiSecret
    );
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
