/**
 * TinkoffApiService
 *
 * T-Invest (Tinkoff Invest) API: gRPC-over-REST with JSON bodies. All
 * requests are POST, auth via Bearer token.
 *
 * Docs: https://tinkoff.github.io/investAPI/
 *
 * Compliance flag: the issuing bank is under sanctions in several
 * jurisdictions. Do not enable this integration for users outside
 * jurisdictions where it is legal to hold a T-Invest account.
 */

import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

interface TinkoffQuotation {
  units?: string;
  nano?: number;
}

export interface TinkoffAccount {
  id: string;
  type: string;
  name: string;
  accessLevel: string;
  status: string;
  openedDate?: string;
}

export interface TinkoffPortfolioPosition {
  figi: string;
  instrumentType: string;
  quantity?: TinkoffQuotation;
  averagePositionPrice?: { currency: string } & TinkoffQuotation;
  currentPrice?: { currency: string } & TinkoffQuotation;
  instrumentUid?: string;
  blocked?: boolean;
  ticker?: string;
}

interface TinkoffPortfolioResponse {
  totalAmountShares?: { currency: string } & TinkoffQuotation;
  totalAmountBonds?: { currency: string } & TinkoffQuotation;
  totalAmountEtf?: { currency: string } & TinkoffQuotation;
  totalAmountCurrencies?: { currency: string } & TinkoffQuotation;
  positions: TinkoffPortfolioPosition[];
}

/**
 * Convert T-Invest's `{ units: "123", nano: 456789012 }` decimal into a
 * plain numeric string preserving precision. 9 fractional digits, then
 * trimmed.
 */
export function tinkoffQuotationToString(q?: TinkoffQuotation): string {
  if (!q) return '0';
  const units = BigInt(q.units ?? '0');
  const nano = q.nano ?? 0;
  const sign = units < 0n || nano < 0 ? '-' : '';
  const absUnits = units < 0n ? -units : units;
  const absNano = Math.abs(nano);
  const fractional = absNano.toString().padStart(9, '0').replace(/0+$/, '');
  return fractional
    ? `${sign}${absUnits.toString()}.${fractional}`
    : `${sign}${absUnits.toString()}`;
}

export class TinkoffApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  private async rpc<TReq, TRes>(method: string, token: string, body: TReq): Promise<TRes> {
    const subKey = credentialBucketKey(token);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/rest/tinkoff.public.invest.api.contract.v1.${method}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        }),
      subKey
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Tinkoff HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return (await response.json()) as TRes;
  }

  async validateToken(token: string): Promise<boolean> {
    try {
      await this.rpc<object, { accounts: TinkoffAccount[] }>('UsersService/GetAccounts', token, {});
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('401') || msg.includes('40003') || msg.includes('Unauthenticated')) {
        return false;
      }
      throw error;
    }
  }

  async getAccounts(token: string): Promise<TinkoffAccount[]> {
    const res = await this.rpc<object, { accounts: TinkoffAccount[] }>(
      'UsersService/GetAccounts',
      token,
      {}
    );
    return res.accounts ?? [];
  }

  async getPortfolio(token: string, accountId: string): Promise<TinkoffPortfolioResponse> {
    return this.rpc<object, TinkoffPortfolioResponse>('OperationsService/GetPortfolio', token, {
      accountId,
      currency: 'RUB',
    });
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
