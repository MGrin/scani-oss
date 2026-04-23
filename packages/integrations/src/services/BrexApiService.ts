/**
 * BrexApiService
 *
 * Brex Platform API. Single bearer user token. We read cash account
 * balances from the Team API.
 *
 * Docs: https://developer.brex.com/
 */

import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

interface BrexMoney {
  amount: number;
  currency: string;
}

export interface BrexCashAccount {
  id: string;
  name: string;
  status: string;
  current_balance: BrexMoney;
  available_balance: BrexMoney;
  account_number?: string;
  routing_number?: string;
  primary?: boolean;
}

interface BrexListResponse<T> {
  items: T[];
  next_cursor?: string;
}

export class BrexApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  private async authedGet<T>(path: string, token: string): Promise<T> {
    const subKey = credentialBucketKey(token);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        }),
      subKey
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brex HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async validateToken(token: string): Promise<boolean> {
    const subKey = credentialBucketKey(token);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/v2/accounts/cash`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brex HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  async getCashAccounts(token: string): Promise<BrexCashAccount[]> {
    const res = await this.authedGet<BrexListResponse<BrexCashAccount>>('/v2/accounts/cash', token);
    return res.items ?? [];
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
