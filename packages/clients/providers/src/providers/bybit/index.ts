import crypto from 'node:crypto';
import type { NewToken } from '@scani/db/schema';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
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
import { ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { splitConcatenatedPair } from '../../core/utils/symbol-splitter';
import { bybitManifest } from './manifest';

export { bybitManifest } from './manifest';

const BYBIT_INSTITUTION_CODE = 'bybit';
const RECV_WINDOW = '5000';

// Bybit caps execution-list date filters at a 7-day span; we slide the
// caller's [since, until] interval forward in 7-day chunks to cover any
// requested range.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const EXECUTION_PAGE_LIMIT = 100;
const TRANSFER_PAGE_LIMIT = 50;

interface BybitCoin {
  coin: string;
  walletBalance: string;
  usdValue: string;
}

interface BybitWalletBalanceResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<{ accountType: string; coin: BybitCoin[] }>;
  };
}

interface BybitExecution {
  symbol: string;
  side: 'Buy' | 'Sell';
  execId: string;
  execQty: string;
  execValue: string;
  execFee: string;
  feeCurrency?: string;
  execTime: string;
}

interface BybitExecutionListResponse {
  retCode: number;
  retMsg: string;
  result: {
    nextPageCursor?: string;
    category?: string;
    list?: BybitExecution[];
  };
}

interface BybitDepositRow {
  coin: string;
  amount: string;
  txID?: string;
  successAt?: string;
  /** Legacy field name on some endpoint variants. */
  successTime?: string;
}

interface BybitDepositResponse {
  retCode: number;
  retMsg: string;
  result: {
    nextPageCursor?: string;
    rows?: BybitDepositRow[];
  };
}

interface BybitWithdrawRow {
  coin: string;
  amount: string;
  withdrawId: string;
  txID?: string;
  withdrawFee?: string;
  createTime?: string;
  updateTime?: string;
}

interface BybitWithdrawResponse {
  retCode: number;
  retMsg: string;
  result: {
    nextPageCursor?: string;
    rows?: BybitWithdrawRow[];
  };
}

export class BybitProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'bybit';
  readonly manifest = bybitManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl: string;

  constructor(limiter: OutflowRateLimiter, baseUrl?: string) {
    super(limiter);
    this.baseUrl = baseUrl ?? 'https://api.bybit.com';
  }

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = Date.now().toString();
    const preSign = timestamp + creds.apiKey + RECV_WINDOW + (req.query ?? '');
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(preSign).digest('hex');
    return {
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    };
  }

  canFetchBalances(c: string): boolean {
    return c === BYBIT_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const data = await this.signedJson<BybitWalletBalanceResponse>(
      { method: 'GET', url: '/v5/account/wallet-balance', query: 'accountType=UNIFIED' },
      creds
    );
    if (data.retCode !== 0) {
      throw new ProviderError(
        `Bybit retCode=${data.retCode}: ${data.retMsg}`,
        'unrecoverable',
        this.providerKey
      );
    }
    const coins = data.result?.list?.[0]?.coin ?? [];

    const out: HoldingSnapshot[] = [];
    for (const c of coins) {
      const wallet = new Decimal(c.walletBalance || '0');
      if (wallet.lte(0)) continue;
      out.push({
        externalId: c.coin,
        tokenIdentity: this.coinIdentity(c.coin),
        balance: wallet.toString(),
        capturedAt: new Date(),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === BYBIT_INSTITUTION_CODE;
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const until = ctx.until ?? new Date();
    // Default look-back when caller passes no `since`: 30 days. The
    // execution-list 7-day window cap means longer ranges fan out
    // into more requests, so the worker normally supplies an explicit
    // `since` from its last-import cursor.
    const since = ctx.since ?? new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);

    const events: TransactionEvent[] = [];
    for await (const exec of this.iterateExecutions(creds, since, until)) {
      const mapped = this.mapExecution(exec);
      if (mapped) events.push(mapped);
    }
    for await (const dep of this.iterateDeposits(creds, since, until)) {
      events.push(this.mapDeposit(dep));
    }
    for await (const wd of this.iterateWithdrawals(creds, since, until)) {
      events.push(this.mapWithdrawal(wd));
    }
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== BYBIT_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };
    try {
      const data = await this.signedJson<{ retCode: number; retMsg: string }>(
        { method: 'GET', url: '/v5/account/wallet-balance', query: 'accountType=UNIFIED' },
        { apiKey, apiSecret }
      );
      if (data.retCode !== 0) {
        return { valid: false, message: `Bybit retCode=${data.retCode}: ${data.retMsg}` };
      }
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async *iterateExecutions(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitExecution> {
    const untilMs = until.getTime();
    let windowStart = since.getTime();
    if (windowStart >= untilMs) return;

    while (windowStart < untilMs) {
      const windowEnd = Math.min(windowStart + SEVEN_DAYS_MS, untilMs);
      let cursor: string | undefined;
      while (true) {
        const params = new URLSearchParams({
          category: 'spot',
          startTime: windowStart.toString(),
          endTime: windowEnd.toString(),
          limit: EXECUTION_PAGE_LIMIT.toString(),
        });
        if (cursor) params.set('cursor', cursor);
        const data = await this.signedJson<BybitExecutionListResponse>(
          { method: 'GET', url: '/v5/execution/list', query: params.toString() },
          creds
        );
        if (data.retCode !== 0) {
          throw new ProviderError(
            `Bybit retCode=${data.retCode}: ${data.retMsg}`,
            'unrecoverable',
            this.providerKey
          );
        }
        const list = data.result?.list ?? [];
        for (const exec of list) yield exec;
        cursor = data.result?.nextPageCursor || undefined;
        if (!cursor || list.length === 0) break;
      }
      windowStart = windowEnd;
    }
  }

  private async *iterateDeposits(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitDepositRow> {
    let cursor: string | undefined;
    while (true) {
      const params = new URLSearchParams({
        startTime: since.getTime().toString(),
        endTime: until.getTime().toString(),
        limit: TRANSFER_PAGE_LIMIT.toString(),
      });
      if (cursor) params.set('cursor', cursor);
      const data = await this.signedJson<BybitDepositResponse>(
        { method: 'GET', url: '/v5/asset/deposit/query-record', query: params.toString() },
        creds
      );
      if (data.retCode !== 0) {
        throw new ProviderError(
          `Bybit retCode=${data.retCode}: ${data.retMsg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = data.result?.rows ?? [];
      for (const row of rows) yield row;
      cursor = data.result?.nextPageCursor || undefined;
      if (!cursor || rows.length === 0) break;
    }
  }

  private async *iterateWithdrawals(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitWithdrawRow> {
    let cursor: string | undefined;
    while (true) {
      const params = new URLSearchParams({
        startTime: since.getTime().toString(),
        endTime: until.getTime().toString(),
        limit: TRANSFER_PAGE_LIMIT.toString(),
      });
      if (cursor) params.set('cursor', cursor);
      const data = await this.signedJson<BybitWithdrawResponse>(
        { method: 'GET', url: '/v5/asset/withdraw/query-record', query: params.toString() },
        creds
      );
      if (data.retCode !== 0) {
        throw new ProviderError(
          `Bybit retCode=${data.retCode}: ${data.retMsg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = data.result?.rows ?? [];
      for (const row of rows) yield row;
      cursor = data.result?.nextPageCursor || undefined;
      if (!cursor || rows.length === 0) break;
    }
  }

  private mapExecution(exec: BybitExecution): TransactionEvent | null {
    const split = splitConcatenatedPair(exec.symbol);
    if (!split) return null;
    const kind: TransactionEvent['kind'] = exec.side === 'Buy' ? 'buy' : 'sell';
    const primaryQty = enforceSign(exec.execQty, kind);
    const counterQty = inferCounterSign(primaryQty, exec.execValue);

    let fee: TransactionEvent['fee'];
    const feeCurrency = exec.feeCurrency || split.quote;
    if (exec.execFee && !new Decimal(exec.execFee).isZero()) {
      fee = {
        tokenIdentity: this.coinIdentity(feeCurrency),
        quantity: negateFee(exec.execFee),
      };
    }

    return {
      externalId: exec.execId,
      occurredAt: new Date(Number.parseInt(exec.execTime, 10)),
      kind,
      primary: {
        tokenIdentity: this.coinIdentity(split.base),
        quantity: primaryQty,
      },
      counter: {
        tokenIdentity: this.coinIdentity(split.quote),
        quantity: counterQty,
      },
      fee,
      rawPayload: exec,
    };
  }

  private mapDeposit(row: BybitDepositRow): TransactionEvent {
    const ts = row.successAt ?? row.successTime ?? '0';
    return {
      externalId: row.txID && row.txID.length > 0 ? row.txID : `deposit-${row.coin}-${ts}`,
      occurredAt: new Date(Number.parseInt(ts, 10) || Date.now()),
      kind: 'deposit',
      primary: {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: enforceSign(row.amount, 'deposit'),
      },
      rawPayload: row,
    };
  }

  private mapWithdrawal(row: BybitWithdrawRow): TransactionEvent {
    const ts = row.updateTime ?? row.createTime ?? '0';
    let fee: TransactionEvent['fee'];
    if (row.withdrawFee && !new Decimal(row.withdrawFee).isZero()) {
      fee = {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: negateFee(row.withdrawFee),
      };
    }
    return {
      externalId: row.withdrawId,
      occurredAt: new Date(Number.parseInt(ts, 10) || Date.now()),
      kind: 'withdraw',
      primary: {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: enforceSign(row.amount, 'withdraw'),
      },
      fee,
      rawPayload: row,
    };
  }

  private coinIdentity(coin: string): Partial<NewToken> {
    return {
      symbol: coin.toUpperCase(),
      name: coin,
      providerMetadata: { bybit: { coin } },
    };
  }
}

export const bybitFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'bybit-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'bybit-private',
    limiter,
    registeredFrom: 'providers/bybit',
    description: 'Bybit V5: 10 req / 1s per API key',
  });
  const baseUrl = deps.env.SCANI_TESTNET_BYBIT_BASE_URL || undefined;
  return new BybitProvider(registered, baseUrl);
};
