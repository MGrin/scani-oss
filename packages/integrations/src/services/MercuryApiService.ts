/**
 * MercuryApiService
 *
 * Mercury Bank API — single bearer/basic token. Read-only token type
 * available (stronger posture; no IP whitelist required).
 *
 * Docs: https://docs.mercury.com/docs/getting-started
 */

import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface MercuryAccount {
  id: string;
  name: string;
  status: string;
  type: string;
  accountNumber?: string;
  routingNumber?: string;
  currentBalance: number;
  availableBalance: number;
  kind?: string;
  nickname?: string;
}

interface MercuryAccountsResponse {
  accounts: MercuryAccount[];
}

export class MercuryApiService {
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
      throw new Error(`Mercury HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async validateToken(token: string): Promise<boolean> {
    const subKey = credentialBucketKey(token);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/accounts`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Mercury HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  async getAccounts(token: string): Promise<MercuryAccount[]> {
    const res = await this.authedGet<MercuryAccountsResponse>('/accounts', token);
    return res.accounts ?? [];
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
