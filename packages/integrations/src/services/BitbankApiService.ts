/**
 * BitbankApiService
 *
 * bitbank.cc authenticated API.
 * - GET /v1/user/assets → { success, data: { assets: [...] } }
 * - HMAC-SHA256 signed, hex-encoded
 * - Signed string for GET: nonce + path + query
 * - Signed string for POST: nonce + body
 *
 * Docs: https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api.md
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

interface BitbankAsset {
  asset: string;
  amount_precision: number;
  onhand_amount: string;
  locked_amount: string;
  free_amount: string;
  withdrawal_fee?: unknown;
  stop_deposit?: boolean;
  stop_withdrawal?: boolean;
}

interface BitbankAssetsResponse {
  success: number;
  data?: { assets: BitbankAsset[] };
  code?: number;
}

export class BitbankApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;
  private lastNonce = 0n;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /** bitbank expects nonce in milliseconds, strictly increasing. */
  private nextNonce(): string {
    const now = BigInt(Date.now());
    const next = now > this.lastNonce ? now : this.lastNonce + 1n;
    this.lastNonce = next;
    return next.toString();
  }

  private createGetSignature(apiSecret: string, nonce: string, pathWithQuery: string): string {
    return crypto.createHmac('sha256', apiSecret).update(`${nonce}${pathWithQuery}`).digest('hex');
  }

  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const nonce = this.nextNonce();
    const path = '/v1/user/assets';
    const signature = this.createGetSignature(apiSecret, nonce, path);
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
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
      throw new Error(`bitbank HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const json = (await response.json()) as BitbankAssetsResponse;
    // bitbank returns 200 even for invalid keys; success=0 + error code
    // is the auth-fail signal.
    if (!json.success) return false;
    return true;
  }

  async getAssets(apiKey: string, apiSecret: string): Promise<BitbankAsset[]> {
    const nonce = this.nextNonce();
    const path = '/v1/user/assets';
    const signature = this.createGetSignature(apiSecret, nonce, path);
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
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
      throw new Error(`bitbank HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const json = (await response.json()) as BitbankAssetsResponse;
    if (!json.success) {
      throw new Error(`bitbank error code ${json.code ?? 'unknown'}`);
    }
    return json.data?.assets ?? [];
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
