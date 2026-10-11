import crypto from 'node:crypto';
import type { NewToken } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
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
import { credentialRejection, ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  JobNotice,
  ProviderContext,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { englishList } from '../../core/utils/english-list';
import { tokenTypeForCexAsset } from '../../core/utils/fiat-codes';
import { namedTypeCounts } from '../../core/utils/named-type-counts';
import { splitConcatenatedPair } from '../../core/utils/symbol-splitter';
import { slidingWindows } from '../../core/utils/time-windows';
import { bybitManifest } from './manifest';

const BYBIT_INSTITUTION_CODE = 'bybit';
const RECV_WINDOW = '5000';

// Bybit caps execution-list date filters at a 7-day span; we slide the
// caller's [since, until] interval forward in 7-day chunks to cover any
// requested range.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const EXECUTION_PAGE_LIMIT = 100;
const TRANSFER_PAGE_LIMIT = 50;

// Bybit caps deposit/withdrawal record queries at a 30-day span; slide the
// caller's [since, until] interval forward in 30-day chunks.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Deposits land in the Funding wallet and withdrawals leave from it, so an
// account is Funding plus Unified. Reading Unified alone showed a user their
// deposit and never their withdrawal (SC-1461).
const FUND_BALANCE_URL = '/v5/asset/transfer/query-account-coins-balance';
const PERMISSION_DENIED = 10005;
// The key itself was refused: invalid, expired, mis-signed, or used from an IP
// it is not bound to. Only its owner can fix that, so it is an auth failure
// rather than a generic one (SC-1686: two expired keys paged as stale syncs).
const KEY_REJECTED = new Set([10003, 10004, 10007, 10010, 33004]);
// `withdrawType` defaults to on-chain only; 2 adds transfers to other Bybit users.
const ALL_WITHDRAW_TYPES = '2';
const INTERNAL_DEPOSIT_SUCCESS = 2;

// The Unified account's transaction log is the only place derivatives PnL,
// funding and liquidations appear; the execution list is spot only. Two users
// lost ~10k USDT on perpetuals the import never saw (SC-1461). Spot trades and
// Funding<->Unified transfers are in the log too and are skipped: the first is
// imported from the execution list, the second nets to zero in the summed balance.
const PNL_LOG_TYPES = new Set(['SETTLEMENT', 'LIQUIDATION', 'DELIVERY', 'ADL']);
const SKIPPED_LOG_TYPES = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'EXEMPTED_INTEREST']);
// Any other type is money that moved with no row to say so. It is counted and
// named in the run's warnings, never guessed into a quantity row (SC-1591).
const IMPORTED_LOG_TYPES = new Set([
  ...PNL_LOG_TYPES,
  'TRADE',
  'INTEREST',
  'CURRENCY_BUY',
  'CURRENCY_SELL',
]);
const FUNDING_PERMISSION_MESSAGE =
  'Bybit API key cannot read the Funding wallet. Enable the "Assets" (Wallet) read permission on the key; without it deposits and withdrawals are invisible and balances would be wrong.';

// How far back a caller-supplied-nothing run reaches. Also published as
// `transactionHistoryHorizonMs` so the coverage flag reflects it.
const DEFAULT_LOOKBACK_MS = THIRTY_DAYS_MS;

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

interface BybitFundCoin {
  coin: string;
  walletBalance: string;
}

interface BybitFundBalanceResponse {
  retCode: number;
  retMsg: string;
  result: { balance?: BybitFundCoin[] };
}

interface BybitInternalDepositRow {
  id: string;
  coin: string;
  amount: string;
  /** 1 processing, 2 success, 3 failed. */
  status: number;
  createdTime: string;
}

interface BybitInternalDepositResponse {
  retCode: number;
  retMsg: string;
  result: {
    nextPageCursor?: string;
    rows?: BybitInternalDepositRow[];
  };
}

interface BybitTransactionLogRow {
  id: string;
  currency: string;
  type: string;
  category?: string;
  change: string;
  transactionTime: string;
  tradeId?: string;
}

interface BybitTransactionLogResponse {
  retCode: number;
  retMsg: string;
  result: {
    nextPageCursor?: string;
    list?: BybitTransactionLogRow[];
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

// Bybit documents the internal-deposit timestamp in seconds, where every
// other record here is milliseconds; read either rather than trust the doc.
function epochToDate(raw: string): Date {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n);
}

const logger = createComponentLogger('provider:bybit');

function describeUnlistedLogTypes(counts: ReadonlyMap<string, number>): JobNotice | null {
  const named = namedTypeCounts(counts, 'v3.jobs.notices.bybitFurtherTypes');
  if (!named) return null;
  const { types, total } = named;
  return {
    key: 'v3.jobs.notices.bybitUnlistedLogTypes',
    params: { count: total },
    lists: { types },
    text:
      `bybit: ${total} transaction-log row${total === 1 ? '' : 's'} had a type Scani does not ` +
      `import — ${englishList(types)} — so the balance change${total === 1 ? ' it carries is' : 's they carry are'} ` +
      'missing from this history. This one is ours to fix, not yours: please report it.',
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
  // `fetchTransactions` substitutes a 30-day look-back when the caller names
  // no `since`, so this provider can never honestly claim to have walked an
  // account's whole ledger. Declaring it is what stops
  // `holding_coverage.has_complete_tx_history` being set true over a month
  // of history (SC-166).
  readonly transactionHistoryHorizonMs = DEFAULT_LOOKBACK_MS;
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

    const unified = await this.signedJson<BybitWalletBalanceResponse>(
      { method: 'GET', url: '/v5/account/wallet-balance', query: 'accountType=UNIFIED' },
      creds
    );
    this.assertOk(unified);
    const fund = await this.fetchFundBalances(creds);

    const totals = new Map<string, { coin: string; balance: Decimal }>();
    const add = (coin: string, amount: string | undefined) => {
      const key = coin.toUpperCase();
      const prev = totals.get(key);
      const value = new Decimal(amount || '0');
      totals.set(key, {
        coin: prev?.coin ?? coin,
        balance: (prev?.balance ?? new Decimal(0)).plus(value),
      });
    };
    for (const c of unified.result?.list?.[0]?.coin ?? []) add(c.coin, c.walletBalance);
    for (const c of fund) add(c.coin, c.walletBalance);

    const out: HoldingSnapshot[] = [];
    const capturedAt = new Date();
    for (const { coin, balance } of totals.values()) {
      if (balance.lte(0)) continue;
      out.push({
        externalId: coin,
        tokenIdentity: this.coinIdentity(coin),
        balance: balance.toString(),
        capturedAt,
        tokenType: tokenTypeForCexAsset(coin),
      });
    }
    return out;
  }

  private async fetchFundBalances(creds: ApiKeyCreds): Promise<BybitFundCoin[]> {
    const data = await this.signedJson<BybitFundBalanceResponse>(
      { method: 'GET', url: FUND_BALANCE_URL, query: 'accountType=FUND' },
      creds
    );
    if (data.retCode === PERMISSION_DENIED) {
      throw new ProviderError(FUNDING_PERMISSION_MESSAGE, 'unrecoverable', this.providerKey);
    }
    this.assertOk(data);
    return data.result?.balance ?? [];
  }

  private assertOk(data: { retCode: number; retMsg: string }): void {
    if (data.retCode !== 0) {
      throw new ProviderError(
        `Bybit retCode=${data.retCode}: ${data.retMsg}`,
        KEY_REJECTED.has(data.retCode) ? 'auth-failed' : 'unrecoverable',
        this.providerKey
      );
    }
  }

  canFetchTransactions(c: string): boolean {
    return c === BYBIT_INSTITUTION_CODE;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const until = ctx.until ?? new Date();
    // Default look-back when caller passes no `since`: 30 days. The
    // execution-list 7-day window cap means longer ranges fan out
    // into more requests, so the worker normally supplies an explicit
    // `since` from its last-import cursor.
    const since = ctx.since ?? new Date(until.getTime() - DEFAULT_LOOKBACK_MS);

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
    for await (const row of this.iterateInternalDeposits(creds, since, until)) {
      if (row.status === INTERNAL_DEPOSIT_SUCCESS) events.push(this.mapInternalDeposit(row));
    }
    const unlisted = new Map<string, number>();
    const logRows = await this.readTransactionLog(creds, since, until);
    events.push(...this.mapTransactionLog(logRows, unlisted));
    const notice = describeUnlistedLogTypes(unlisted);
    if (notice) {
      logger.warn(
        { types: Object.fromEntries(unlisted), rows: notice.params?.count },
        'Bybit transaction-log rows of a type the import does not map'
      );
      ctx.noteWarning?.(notice);
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
      const fund = await this.signedJson<BybitFundBalanceResponse>(
        { method: 'GET', url: FUND_BALANCE_URL, query: 'accountType=FUND' },
        { apiKey, apiSecret }
      );
      if (fund.retCode === PERMISSION_DENIED) {
        return { valid: false, message: FUNDING_PERMISSION_MESSAGE };
      }
      if (fund.retCode !== 0) {
        return { valid: false, message: `Bybit retCode=${fund.retCode}: ${fund.retMsg}` };
      }
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  private async *iterateExecutions(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitExecution> {
    for (const window of slidingWindows(since, until, SEVEN_DAYS_MS)) {
      const windowStart = window.start.getTime();
      const windowEnd = window.end.getTime();
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
        this.assertOk(data);
        const list = data.result?.list ?? [];
        for (const exec of list) yield exec;
        cursor = data.result?.nextPageCursor || undefined;
        if (!cursor || list.length === 0) break;
      }
    }
  }

  private async *iterateDeposits(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitDepositRow> {
    for (const window of slidingWindows(since, until, THIRTY_DAYS_MS)) {
      const windowStart = window.start.getTime();
      const windowEnd = window.end.getTime();
      let cursor: string | undefined;
      while (true) {
        const params = new URLSearchParams({
          startTime: windowStart.toString(),
          endTime: windowEnd.toString(),
          limit: TRANSFER_PAGE_LIMIT.toString(),
        });
        if (cursor) params.set('cursor', cursor);
        const data = await this.signedJson<BybitDepositResponse>(
          { method: 'GET', url: '/v5/asset/deposit/query-record', query: params.toString() },
          creds
        );
        this.assertOk(data);
        const rows = data.result?.rows ?? [];
        for (const row of rows) yield row;
        cursor = data.result?.nextPageCursor || undefined;
        if (!cursor || rows.length === 0) break;
      }
    }
  }

  private async *iterateWithdrawals(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitWithdrawRow> {
    for (const window of slidingWindows(since, until, THIRTY_DAYS_MS)) {
      const windowStart = window.start.getTime();
      const windowEnd = window.end.getTime();
      let cursor: string | undefined;
      while (true) {
        const params = new URLSearchParams({
          startTime: windowStart.toString(),
          endTime: windowEnd.toString(),
          limit: TRANSFER_PAGE_LIMIT.toString(),
          withdrawType: ALL_WITHDRAW_TYPES,
        });
        if (cursor) params.set('cursor', cursor);
        const data = await this.signedJson<BybitWithdrawResponse>(
          { method: 'GET', url: '/v5/asset/withdraw/query-record', query: params.toString() },
          creds
        );
        this.assertOk(data);
        const rows = data.result?.rows ?? [];
        for (const row of rows) yield row;
        cursor = data.result?.nextPageCursor || undefined;
        if (!cursor || rows.length === 0) break;
      }
    }
  }

  private async *iterateInternalDeposits(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BybitInternalDepositRow> {
    for (const window of slidingWindows(since, until, THIRTY_DAYS_MS)) {
      let cursor: string | undefined;
      while (true) {
        const params = new URLSearchParams({
          startTime: window.start.getTime().toString(),
          endTime: window.end.getTime().toString(),
          limit: TRANSFER_PAGE_LIMIT.toString(),
        });
        if (cursor) params.set('cursor', cursor);
        const data = await this.signedJson<BybitInternalDepositResponse>(
          {
            method: 'GET',
            url: '/v5/asset/deposit/query-internal-record',
            query: params.toString(),
          },
          creds
        );
        this.assertOk(data);
        const rows = data.result?.rows ?? [];
        for (const row of rows) yield row;
        cursor = data.result?.nextPageCursor || undefined;
        if (!cursor || rows.length === 0) break;
      }
    }
  }

  private async readTransactionLog(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): Promise<BybitTransactionLogRow[]> {
    // Adjacent windows share their boundary instant, and funding settles on
    // the hour, so a row can come back twice: keyed on Bybit's own id.
    const rows = new Map<string, BybitTransactionLogRow>();
    for (const window of slidingWindows(since, until, SEVEN_DAYS_MS)) {
      let cursor: string | undefined;
      while (true) {
        const params = new URLSearchParams({
          accountType: 'UNIFIED',
          startTime: window.start.getTime().toString(),
          endTime: window.end.getTime().toString(),
          limit: TRANSFER_PAGE_LIMIT.toString(),
        });
        if (cursor) params.set('cursor', cursor);
        const data = await this.signedJson<BybitTransactionLogResponse>(
          { method: 'GET', url: '/v5/account/transaction-log', query: params.toString() },
          creds
        );
        this.assertOk(data);
        const list = data.result?.list ?? [];
        for (const row of list) rows.set(row.id, row);
        cursor = data.result?.nextPageCursor || undefined;
        if (!cursor || list.length === 0) break;
      }
    }
    return [...rows.values()];
  }

  private mapTransactionLog(
    rows: BybitTransactionLogRow[],
    unlisted: Map<string, number>
  ): TransactionEvent[] {
    const events: TransactionEvent[] = [];
    const conversions = new Map<
      string,
      { buy?: BybitTransactionLogRow; sell?: BybitTransactionLogRow }
    >();
    for (const row of rows) {
      if (SKIPPED_LOG_TYPES.has(row.type)) continue;
      if (!IMPORTED_LOG_TYPES.has(row.type)) {
        if (!new Decimal(row.change || '0').isZero()) {
          unlisted.set(row.type, (unlisted.get(row.type) ?? 0) + 1);
        }
        continue;
      }
      if (row.type === 'TRADE' && (row.category ?? 'spot') === 'spot') continue;
      if (row.type === 'CURRENCY_BUY' || row.type === 'CURRENCY_SELL') {
        const key = row.tradeId || row.id;
        const pair = conversions.get(key) ?? {};
        if (row.type === 'CURRENCY_BUY') pair.buy = row;
        else pair.sell = row;
        conversions.set(key, pair);
        continue;
      }
      const change = new Decimal(row.change || '0');
      if (change.isZero()) continue;
      let kind: TransactionEvent['kind'];
      if (row.type === 'TRADE' || PNL_LOG_TYPES.has(row.type)) kind = 'realized_pnl';
      else if (row.type === 'INTEREST') kind = change.isNegative() ? 'fee' : 'interest';
      else continue;
      events.push({
        externalId: `txlog-${row.id}`,
        occurredAt: epochToDate(row.transactionTime),
        kind,
        primary: { tokenIdentity: this.coinIdentity(row.currency), quantity: change.toString() },
        rawPayload: row,
      });
    }
    // Bybit repays a negative balance by selling another coin for it: one
    // CURRENCY_SELL and one CURRENCY_BUY sharing a tradeId, i.e. a spot sale.
    for (const [key, { buy, sell }] of conversions) {
      if (!buy || !sell) continue;
      events.push({
        externalId: `txlog-convert-${key}`,
        occurredAt: epochToDate(sell.transactionTime),
        kind: 'sell',
        primary: {
          tokenIdentity: this.coinIdentity(sell.currency),
          quantity: enforceSign(sell.change, 'sell'),
        },
        counter: {
          tokenIdentity: this.coinIdentity(buy.currency),
          quantity: new Decimal(buy.change).abs().toString(),
        },
        rawPayload: { buy, sell },
      });
    }
    return events;
  }

  private mapInternalDeposit(row: BybitInternalDepositRow): TransactionEvent {
    return {
      externalId: `internal-deposit-${row.id}`,
      occurredAt: epochToDate(row.createdTime),
      kind: 'deposit',
      primary: {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: enforceSign(row.amount, 'deposit'),
      },
      rawPayload: row,
    };
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
