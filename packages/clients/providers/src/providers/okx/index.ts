import crypto from 'node:crypto';
import type { NewToken } from '@scani/db/schema';
import { createOutflowLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import {
  type ApiKeyCreds,
  BaseHmacCexProvider,
  type SignedRequest,
} from '../../core/base/base-hmac-cex-provider';
import type { ProviderFactory } from '../../core/boot';
import type {
  BalanceProvider,
  Capability,
  CredentialValidator,
  TransactionsProvider,
} from '../../core/capabilities';
import { loadProvidersConfig } from '../../core/config';
import { ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { mapOkxBillToEvent, type OkxBill, type OkxBillsResponse } from './bill-mapper';
import { okxManifest } from './manifest';
import {
  mapOkxDepositToEvent,
  mapOkxWithdrawalToEvent,
  type OkxTransfer,
  type OkxTransfersResponse,
} from './transfer-mapper';

export { okxManifest } from './manifest';

const OKX_INSTITUTION_CODE = 'okx';

// Bills feed page size cap; OKX returns at most 100 rows per call and
// supports `after`-by-billId cursor pagination.
const BILLS_PAGE_LIMIT = 100;
const MAX_BILL_PAGES = 50;
const TRANSFERS_PAGE_LIMIT = 100;
const MAX_TRANSFER_PAGES = 50;

// Bills feed only goes back 7 days; bills-archive covers 3 months. We
// hit bills first so recent activity doesn't burn the heavier
// `bills-archive` weight (4 vs 2).
const BILLS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface OkxBalanceDetail {
  ccy: string;
  cashBal: string;
  eqUsd: string;
}

interface OkxBalanceResponse {
  code: string;
  msg: string;
  data: Array<{ totalEq: string; details: OkxBalanceDetail[] }>;
}

export class OkxProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'okx';
  readonly manifest = okxManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = 'https://www.okx.com';

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = new Date().toISOString();
    const queryStr = req.query ? `?${req.query}` : '';
    const preSign = timestamp + req.method + req.url + queryStr + (req.body ?? '');
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(preSign).digest('base64');
    const headers: Record<string, string> = {
      'OK-ACCESS-KEY': creds.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': creds.passphrase ?? '',
    };
    // Demo-trading flag: OKX routes signed requests to its sandbox
    // when this header is set. Toggled per-deployment via env so the
    // same key/secret can hit prod in one workspace and demo in another.
    if (loadProvidersConfig().SCANI_TESTNET_OKX_SIMULATED === '1') {
      headers['x-simulated-trading'] = '1';
    }
    return headers;
  }

  canFetchBalances(c: string): boolean {
    return c === OKX_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds?.passphrase) return [];

    const data = await this.signedJson<OkxBalanceResponse>(
      { method: 'GET', url: '/api/v5/account/balance' },
      creds
    );
    if (data.code !== '0') {
      throw new ProviderError(
        `OKX code=${data.code}: ${data.msg}`,
        'unrecoverable',
        this.providerKey
      );
    }
    const details = data.data?.[0]?.details ?? [];

    const out: HoldingSnapshot[] = [];
    for (const d of details) {
      const cash = new Decimal(d.cashBal || '0');
      if (cash.lte(0)) continue;
      const tokenIdentity: Partial<NewToken> = {
        symbol: d.ccy.toUpperCase(),
        name: d.ccy,
        providerMetadata: { okx: { ccy: d.ccy } },
      };
      out.push({
        externalId: d.ccy,
        tokenIdentity,
        balance: cash.toString(),
        capturedAt: new Date(),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === OKX_INSTITUTION_CODE;
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds?.passphrase) return [];

    const sinceMs = ctx.since ? ctx.since.getTime() : undefined;
    const untilMs = ctx.until ? ctx.until.getTime() : undefined;

    const events: TransactionEvent[] = [];

    // Bills (last 7d). Trade + funding-fee events only — transfers are
    // sourced from the dedicated deposit/withdrawal endpoints below so
    // we can keep the on-chain txId those carry.
    const recentBills = await this.paginateBills('/api/v5/account/bills', creds, sinceMs, untilMs);
    for (const bill of recentBills) {
      if (bill.type === '1') continue;
      const ev = mapOkxBillToEvent(bill);
      if (ev) events.push(ev);
    }

    // Bills-archive (3 months) only when the caller wants something
    // older than the 7-day live feed covers.
    const cutoff = Date.now() - BILLS_WINDOW_MS;
    if (sinceMs !== undefined && sinceMs < cutoff) {
      const archive = await this.paginateBills(
        '/api/v5/account/bills-archive',
        creds,
        sinceMs,
        Math.min(untilMs ?? cutoff, cutoff)
      );
      for (const bill of archive) {
        if (bill.type === '1') continue;
        const ev = mapOkxBillToEvent(bill);
        if (ev) events.push(ev);
      }
    }

    const deposits = await this.paginateTransfers(
      '/api/v5/asset/deposit-history',
      creds,
      sinceMs,
      untilMs
    );
    for (const d of deposits) {
      const ev = mapOkxDepositToEvent(d);
      if (ev) events.push(ev);
    }

    const withdrawals = await this.paginateTransfers(
      '/api/v5/asset/withdrawal-history',
      creds,
      sinceMs,
      untilMs
    );
    for (const w of withdrawals) {
      const ev = mapOkxWithdrawalToEvent(w);
      if (ev) events.push(ev);
    }

    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== OKX_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    const passphrase = creds.passphrase as string | undefined;
    if (!apiKey || !apiSecret || !passphrase) {
      return { valid: false, message: 'apiKey + apiSecret + passphrase required' };
    }
    try {
      const data = await this.signedJson<{ code: string; msg: string }>(
        { method: 'GET', url: '/api/v5/account/balance' },
        { apiKey, apiSecret, passphrase }
      );
      if (data.code !== '0') {
        return { valid: false, message: `OKX code=${data.code}: ${data.msg}` };
      }
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Walk the bills feed via the `after`-by-billId cursor. OKX returns
   * rows newest-first; we stop once we cross `since` or run out of
   * data. `until` filters the per-row timestamp on the way through —
   * the API itself only filters by bill ID, not timestamp.
   */
  private async paginateBills(
    path: '/api/v5/account/bills' | '/api/v5/account/bills-archive',
    creds: ApiKeyCreds,
    sinceMs: number | undefined,
    untilMs: number | undefined
  ): Promise<OkxBill[]> {
    const out: OkxBill[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_BILL_PAGES; page += 1) {
      const query = new URLSearchParams();
      query.set('limit', String(BILLS_PAGE_LIMIT));
      if (after) query.set('after', after);
      const res = await this.signedJson<OkxBillsResponse>(
        { method: 'GET', url: path, query: query.toString() },
        creds
      );
      if (res.code !== '0') {
        throw new ProviderError(
          `OKX code=${res.code}: ${res.msg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = res.data ?? [];
      if (rows.length === 0) break;
      let crossedSince = false;
      for (const row of rows) {
        const ts = Number(row.ts);
        if (untilMs !== undefined && ts > untilMs) continue;
        if (sinceMs !== undefined && ts < sinceMs) {
          crossedSince = true;
          continue;
        }
        out.push(row);
      }
      if (crossedSince) break;
      if (rows.length < BILLS_PAGE_LIMIT) break;
      after = rows[rows.length - 1]?.billId;
      if (!after) break;
    }
    return out;
  }

  /**
   * Deposit/withdrawal feeds use a `ts` cursor: passing `after=<ts>`
   * returns rows older than `ts`. We seed from "now" and walk
   * backwards until we cross `since`.
   */
  private async paginateTransfers(
    path: '/api/v5/asset/deposit-history' | '/api/v5/asset/withdrawal-history',
    creds: ApiKeyCreds,
    sinceMs: number | undefined,
    untilMs: number | undefined
  ): Promise<OkxTransfer[]> {
    const out: OkxTransfer[] = [];
    let after: string | undefined = untilMs !== undefined ? String(untilMs) : undefined;
    for (let page = 0; page < MAX_TRANSFER_PAGES; page += 1) {
      const query = new URLSearchParams();
      query.set('limit', String(TRANSFERS_PAGE_LIMIT));
      if (after) query.set('after', after);
      const res = await this.signedJson<OkxTransfersResponse>(
        { method: 'GET', url: path, query: query.toString() },
        creds
      );
      if (res.code !== '0') {
        throw new ProviderError(
          `OKX code=${res.code}: ${res.msg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = res.data ?? [];
      if (rows.length === 0) break;
      let crossedSince = false;
      for (const row of rows) {
        const ts = Number(row.ts);
        if (sinceMs !== undefined && ts < sinceMs) {
          crossedSince = true;
          continue;
        }
        out.push(row);
      }
      if (crossedSince) break;
      if (rows.length < TRANSFERS_PAGE_LIMIT) break;
      const lastTs = rows[rows.length - 1]?.ts;
      if (!lastTs) break;
      after = lastTs;
    }
    return out;
  }
}

export const okxFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'okx-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'okx-private',
    limiter,
    registeredFrom: 'providers/okx',
    description: 'OKX V5: 10 req / 1s per API key',
  });
  return new OkxProvider(registered);
};

export type { OkxBill, OkxBillsResponse } from './bill-mapper';
export { mapOkxBillToEvent } from './bill-mapper';
export type { OkxTransfer, OkxTransfersResponse } from './transfer-mapper';
export { mapOkxDepositToEvent, mapOkxWithdrawalToEvent } from './transfer-mapper';
