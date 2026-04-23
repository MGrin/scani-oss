/**
 * CoincheckApiService
 *
 * Coincheck Exchange API authenticated endpoints.
 * - GET /api/accounts/balance → `{currency}: "<balance>"`
 * - HMAC-SHA256 signed, hex-encoded
 * - Signed string: nonce + FULL URL + body (body "" for GET)
 *
 * Docs: https://coincheck.com/documents/exchange/api
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

type CoincheckBalanceResponse = {
  success: boolean;
  error?: string;
} & Record<string, string | boolean | undefined>;

export class CoincheckApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;
  private lastNonce = 0n;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  private nextNonce(): string {
    const now = BigInt(Date.now());
    const next = now > this.lastNonce ? now : this.lastNonce + 1n;
    this.lastNonce = next;
    return next.toString();
  }

  private createSignature(apiSecret: string, nonce: string, url: string, body: string): string {
    const message = `${nonce}${url}${body}`;
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  }

  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const nonce = this.nextNonce();
    const url = `${this.baseUrl}/api/accounts/balance`;
    const signature = this.createSignature(apiSecret, nonce, url, '');
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(url, {
          method: 'GET',
          headers: {
            'ACCESS-KEY': apiKey,
            'ACCESS-NONCE': nonce,
            'ACCESS-SIGNATURE': signature,
          },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Coincheck HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as CoincheckBalanceResponse;
    if (data.success === false) return false;
    return true;
  }

  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ currency: string; balance: string }>> {
    const nonce = this.nextNonce();
    const url = `${this.baseUrl}/api/accounts/balance`;
    const signature = this.createSignature(apiSecret, nonce, url, '');
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(url, {
          method: 'GET',
          headers: {
            'ACCESS-KEY': apiKey,
            'ACCESS-NONCE': nonce,
            'ACCESS-SIGNATURE': signature,
          },
        }),
      subKey
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Coincheck HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as CoincheckBalanceResponse;
    if (data.success === false) {
      throw new Error(`Coincheck: ${data.error ?? 'unknown error'}`);
    }

    const out: Array<{ currency: string; balance: string }> = [];
    for (const [key, value] of Object.entries(data)) {
      // Skip metadata keys (`success`, `error`, and any `_reserved` /
      // `_lend_in_use` sibling fields we don't map as balances).
      if (key === 'success' || key === 'error') continue;
      if (typeof value !== 'string') continue;
      if (key.includes('_')) continue; // e.g. jpy_reserved, btc_lend_in_use
      out.push({ currency: key, balance: value });
    }
    return out;
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
