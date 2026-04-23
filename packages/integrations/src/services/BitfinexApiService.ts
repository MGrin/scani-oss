/**
 * BitfinexApiService
 *
 * Bitfinex v2 authenticated API.
 * - POST /v2/auth/r/wallets → tuple-encoded wallets per type/currency
 * - HMAC-SHA384 signed, hex-encoded
 * - Signed string: `/api/v2/auth/r/wallets` + nonce + JSON-body
 *
 * Docs: https://docs.bitfinex.com/docs/rest-auth
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * The wallets endpoint returns rows shaped as
 * [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED_INTEREST, AVAILABLE_BALANCE,
 *  LAST_CHANGE, TRADE_DETAILS]
 */
export type BitfinexWalletRow = [
  string, // WALLET_TYPE: 'exchange' | 'margin' | 'funding'
  string, // CURRENCY
  number, // BALANCE
  number, // UNSETTLED_INTEREST
  number | null, // AVAILABLE_BALANCE
  string | null, // LAST_CHANGE
  unknown, // TRADE_DETAILS
];

export class BitfinexApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;
  private lastNonce = 0n;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /** Nanosecond-scale strictly-increasing nonce as a string. */
  private nextNonce(): string {
    // Nanos = ms * 1e6 + drift within the millisecond. Gives ~19-digit
    // nonces that survive multiple calls per ms.
    const nanos = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
    const next = nanos > this.lastNonce ? nanos : this.lastNonce + 1n;
    this.lastNonce = next;
    return next.toString();
  }

  private createSignature(
    apiSecret: string,
    apiPath: string,
    nonce: string,
    rawBody: string
  ): string {
    const message = `/api/${apiPath}${nonce}${rawBody}`;
    return crypto.createHmac('sha384', apiSecret).update(message).digest('hex');
  }

  private async signedPost<T>(
    apiPath: string,
    apiKey: string,
    apiSecret: string,
    body: Record<string, unknown> = {}
  ): Promise<T> {
    const nonce = this.nextNonce();
    const rawBody = JSON.stringify(body);
    const signature = this.createSignature(apiSecret, apiPath, nonce, rawBody);

    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/${apiPath}`, {
          method: 'POST',
          headers: {
            'bfx-apikey': apiKey,
            'bfx-nonce': nonce,
            'bfx-signature': signature,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: rawBody,
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Bitfinex HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      await this.signedPost<BitfinexWalletRow[]>('v2/auth/r/wallets', apiKey, apiSecret);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('401') || msg.includes('403') || msg.includes('apikey: invalid')) {
        return false;
      }
      throw error;
    }
  }

  async getWallets(apiKey: string, apiSecret: string): Promise<BitfinexWalletRow[]> {
    return this.signedPost<BitfinexWalletRow[]>('v2/auth/r/wallets', apiKey, apiSecret);
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
