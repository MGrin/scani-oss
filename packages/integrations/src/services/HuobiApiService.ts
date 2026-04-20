/**
 * HuobiApiService
 *
 * Handles Huobi (HTX) API communications for API Key authentication.
 * Uses HMAC-SHA256 signed requests with query parameter authentication.
 */

import crypto from 'node:crypto';
import type { RateLimiter } from '../types';

interface HuobiBalance {
  currency: string;
  type: string; // 'trade', 'frozen', 'loan', 'interest'
  balance: string;
}

interface HuobiAccountsResponse {
  status: string;
  data: Array<{
    id: number;
    type: string; // 'spot', 'margin', 'otc', 'super-margin'
    state: string;
  }>;
}

interface HuobiBalanceResponse {
  status: string;
  data: {
    id: number;
    type: string;
    state: string;
    list: HuobiBalance[];
  };
}

export class HuobiApiService {
  private readonly baseUrl: string;

  constructor(baseUrl = 'https://api.huobi.pro', _rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
  }

  private sign(
    method: string,
    path: string,
    params: Record<string, string>,
    secret: string
  ): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(params[k]!)}`)
      .join('&');
    const payload = `${method}\napi.huobi.pro\n${path}\n${sortedParams}`;
    return crypto.createHmac('sha256', secret).update(payload).digest('base64');
  }

  private getAuthParams(apiKey: string): Record<string, string> {
    return {
      AccessKeyId: apiKey,
      SignatureMethod: 'HmacSHA256',
      SignatureVersion: '2',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    };
  }

  async getAccounts(apiKey: string, apiSecret: string): Promise<HuobiAccountsResponse['data']> {
    const path = '/v1/account/accounts';
    const params = this.getAuthParams(apiKey);
    params.Signature = this.sign('GET', path, params, apiSecret);

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const response = await fetch(`${this.baseUrl}${path}?${queryString}`);
    if (!response.ok) throw new Error(`Huobi API error: ${response.status}`);

    const data = (await response.json()) as HuobiAccountsResponse;
    if (data.status !== 'ok') throw new Error(`Huobi API error: ${data.status}`);

    return data.data;
  }

  async getBalance(apiKey: string, apiSecret: string, accountId: number): Promise<HuobiBalance[]> {
    const path = `/v1/account/accounts/${accountId}/balance`;
    const params = this.getAuthParams(apiKey);
    params.Signature = this.sign('GET', path, params, apiSecret);

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const response = await fetch(`${this.baseUrl}${path}?${queryString}`);
    if (!response.ok) throw new Error(`Huobi balance API error: ${response.status}`);

    const data = (await response.json()) as HuobiBalanceResponse;
    if (data.status !== 'ok') throw new Error(`Huobi balance error: ${data.status}`);

    return data.data.list;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<boolean> {
    const accounts = await this.getAccounts(apiKey, apiSecret);
    if (accounts.length === 0) {
      throw new Error('Huobi returned no accounts for these credentials');
    }
    return true;
  }
}
