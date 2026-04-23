/**
 * TigerApiService
 *
 * Tiger Brokers Open API. Uses a gateway pattern with RSA-signed JSON
 * bodies. User provides tiger_id (developer ID) + a PEM-encoded private
 * key (PKCS#1 or PKCS#8); our client signs each request and Tiger
 * verifies against the public key uploaded during onboarding.
 *
 * Signing: RSA-SHA1 over `k1=v1&k2=v2&…` (params sorted lexicographically,
 * `sign` itself excluded). Base64-encoded.
 *
 * Docs: https://quant.itigerup.com/openapi/en/python/operation/prepare/develop.html
 *
 * Credential storage: we pack both tiger_id and the PEM private key into
 * a single secrets blob — `apiKey` holds tiger_id, `apiSecret` holds
 * the PEM block.
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface TigerPosition {
  symbol: string;
  contract_id?: string;
  quantity: number;
  average_cost?: number;
  market_price?: number;
  market_value?: number;
  unrealized_pnl?: number;
  currency?: string;
  sec_type?: string;
  account?: string;
}

interface TigerGatewayResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

export class TigerApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /** YYYY-MM-DD HH:mm:ss in UTC — Tiger's required timestamp format. */
  private formatTimestamp(d = new Date()): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    );
  }

  private buildSignString(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== '')
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  private sign(privateKeyPem: string, params: Record<string, string>): string {
    const signString = this.buildSignString(params);
    const signer = crypto.createSign('RSA-SHA1');
    signer.update(signString, 'utf8');
    return signer.sign(privateKeyPem, 'base64');
  }

  private async invoke<T>(
    tigerId: string,
    privateKeyPem: string,
    method: string,
    bizContent: Record<string, unknown>
  ): Promise<T> {
    const params: Record<string, string> = {
      tiger_id: tigerId,
      method,
      charset: 'UTF-8',
      sign_type: 'RSA',
      timestamp: this.formatTimestamp(),
      version: '2.0',
      biz_content: JSON.stringify(bizContent),
    };
    params.sign = this.sign(privateKeyPem, params);

    const subKey = credentialBucketKey(tigerId);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/gateway`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(params),
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Tiger Brokers HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      );
    }
    const json = (await response.json()) as TigerGatewayResponse<T>;
    if (json.code !== 0) {
      throw new Error(`Tiger Brokers error ${json.code}: ${json.message ?? 'unknown'}`);
    }
    return json.data as T;
  }

  async validateCredentials(tigerId: string, privateKeyPem: string): Promise<boolean> {
    try {
      await this.invoke<unknown>(tigerId, privateKeyPem, 'accounts', {});
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('401') || msg.includes('403') || msg.includes('sign')) {
        return false;
      }
      throw error;
    }
  }

  async getAccounts(
    tigerId: string,
    privateKeyPem: string
  ): Promise<Array<{ account: string; capability?: string; status?: string }>> {
    return this.invoke<Array<{ account: string; capability?: string; status?: string }>>(
      tigerId,
      privateKeyPem,
      'accounts',
      {}
    );
  }

  async getPositions(
    tigerId: string,
    privateKeyPem: string,
    account: string
  ): Promise<TigerPosition[]> {
    const data = await this.invoke<{ items?: TigerPosition[] } | TigerPosition[]>(
      tigerId,
      privateKeyPem,
      'positions',
      { account, sec_type: 'ALL' }
    );
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
