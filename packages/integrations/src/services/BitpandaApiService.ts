/**
 * BitpandaApiService
 *
 * Bitpanda retail API (the broker product, not Bitpanda Pro / Exchange).
 * Single-token authentication via `X-Api-Key`. No HMAC signing needed.
 *
 * Docs: https://developers.bitpanda.com/
 */

import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

interface BitpandaJsonApiWallet {
  type: string;
  id: string;
  attributes: {
    cryptocoin_id?: string;
    cryptocoin_symbol?: string;
    fiat_id?: string;
    fiat_symbol?: string;
    balance: string;
    name?: string;
    pending_transactions_count?: number;
  };
}

interface BitpandaJsonApiResponse<T> {
  data: T[];
}

export interface BitpandaWalletBalance {
  symbol: string;
  balance: string;
  walletType: 'crypto' | 'fiat';
  walletId: string;
  walletName: string;
}

export class BitpandaApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  private async authedGet<T>(path: string, apiKey: string): Promise<T> {
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            'X-Api-Key': apiKey,
            Accept: 'application/json',
          },
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Bitpanda HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async validateApiKey(apiKey: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/v1/wallets`, {
          method: 'GET',
          headers: { 'X-Api-Key': apiKey },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Bitpanda HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  /** Crypto + fiat wallets merged into a single flat balance list. */
  async getAllBalances(apiKey: string): Promise<BitpandaWalletBalance[]> {
    const [crypto, fiat] = await Promise.all([
      this.authedGet<BitpandaJsonApiResponse<BitpandaJsonApiWallet>>('/v1/wallets', apiKey),
      this.authedGet<BitpandaJsonApiResponse<BitpandaJsonApiWallet>>('/v1/fiatwallets', apiKey),
    ]);

    const results: BitpandaWalletBalance[] = [];
    for (const w of crypto.data) {
      const symbol = w.attributes.cryptocoin_symbol?.toUpperCase();
      if (!symbol) continue;
      results.push({
        symbol,
        balance: w.attributes.balance,
        walletType: 'crypto',
        walletId: w.id,
        walletName: w.attributes.name ?? symbol,
      });
    }
    for (const w of fiat.data) {
      const symbol = w.attributes.fiat_symbol?.toUpperCase();
      if (!symbol) continue;
      results.push({
        symbol,
        balance: w.attributes.balance,
        walletType: 'fiat',
        walletId: w.id,
        walletName: w.attributes.name ?? symbol,
      });
    }
    return results;
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
