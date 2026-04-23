/**
 * AlpacaApiService
 *
 * Alpaca Trading API v2. No HMAC — two simple header values.
 * - GET /v2/account → cash, buying power, portfolio value
 * - GET /v2/positions → all open positions (stocks/crypto/options)
 *
 * Docs: https://docs.alpaca.markets/docs/authentication
 */

import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
  equity: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  current_price: string;
}

export class AlpacaApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  private async authedGet<T>(path: string, apiKey: string, apiSecret: string): Promise<T> {
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            'APCA-API-KEY-ID': apiKey,
            'APCA-API-SECRET-KEY': apiSecret,
            Accept: 'application/json',
          },
        }),
      subKey
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Alpaca HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/v2/account`, {
          method: 'GET',
          headers: {
            'APCA-API-KEY-ID': apiKey,
            'APCA-API-SECRET-KEY': apiSecret,
          },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Alpaca HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  async getAccount(apiKey: string, apiSecret: string): Promise<AlpacaAccount> {
    return this.authedGet<AlpacaAccount>('/v2/account', apiKey, apiSecret);
  }

  async getPositions(apiKey: string, apiSecret: string): Promise<AlpacaPosition[]> {
    return this.authedGet<AlpacaPosition[]>('/v2/positions', apiKey, apiSecret);
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
