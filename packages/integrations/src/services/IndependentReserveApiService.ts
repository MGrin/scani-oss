/**
 * IndependentReserveApiService
 *
 * Handles Independent Reserve API communications for API Key authentication:
 * - Account balance retrieval via GetAccounts
 * - API key validation via signed requests
 *
 * Docs: https://www.independentreserve.com/features/api
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface IndependentReserveAccount {
  AccountGuid: string;
  AccountStatus: string;
  AvailableBalance: number;
  TotalBalance: number;
  CurrencyCode: string;
}

export class IndependentReserveApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  private lastNonce = 0n;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Strictly-increasing millisecond nonce. Independent Reserve expects an
   * integer nonce that only ever grows within a key. `Date.now()` is fine
   * on its own unless two calls land in the same millisecond — the
   * in-memory counter guarantees monotonicity within the process.
   */
  private nextNonce(): string {
    const now = BigInt(Date.now());
    const next = now > this.lastNonce ? now : this.lastNonce + 1n;
    this.lastNonce = next;
    return next.toString();
  }

  /**
   * Signature = HMAC-SHA256(
   *   URL + "," + "apiKey=" + key + "," + "nonce=" + nonce + per-param "," + "name=value",
   *   apiSecret
   * )
   * hex-encoded. Params must appear in the signed string in the same order
   * as they appear in the request body.
   */
  private createSignature(
    apiSecret: string,
    url: string,
    orderedParams: Array<[string, string]>
  ): string {
    const paramParts = orderedParams.map(([k, v]) => `${k}=${v}`);
    const message = [url, ...paramParts].join(',');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  }

  /**
   * Make an authenticated POST against an Independent Reserve Private
   * endpoint. Builds the signed body `{ apiKey, nonce, signature, ...params }`.
   */
  private async signedPost<T>(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    extraParams: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const nonce = this.nextNonce();

    const ordered: Array<[string, string]> = [
      ['apiKey', apiKey],
      ['nonce', nonce],
      ...Object.entries(extraParams).map(([k, v]) => [k, String(v)] as [string, string]),
    ];

    const signature = this.createSignature(apiSecret, url, ordered);

    const body: Record<string, string> = {
      apiKey,
      nonce,
      signature,
    };
    for (const [k, v] of Object.entries(extraParams)) {
      body[k] = String(v);
    }

    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const snippet = text ? `: ${text.slice(0, 200)}` : '';
      throw new Error(`Independent Reserve HTTP ${response.status}${snippet}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Validate API key by calling GetAccounts.
   * Returns false on 401/403, throws on other failures so the UI can
   * surface the provider's actual error (bad signature, bad nonce, etc.).
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const url = `${this.baseUrl}/Private/GetAccounts`;
    const nonce = this.nextNonce();
    const signature = this.createSignature(apiSecret, url, [
      ['apiKey', apiKey],
      ['nonce', nonce],
    ]);

    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, nonce, signature }),
        }),
      subKey
    );

    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const snippet = text ? `: ${text.slice(0, 200)}` : '';
      throw new Error(`Independent Reserve HTTP ${response.status}${snippet}`);
    }
    return true;
  }

  /**
   * Fetch all accounts (one row per currency) with their balances.
   */
  async getAccounts(apiKey: string, apiSecret: string): Promise<IndependentReserveAccount[]> {
    return this.signedPost<IndependentReserveAccount[]>('/Private/GetAccounts', apiKey, apiSecret);
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
