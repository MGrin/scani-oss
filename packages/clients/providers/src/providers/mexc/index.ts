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
import { ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { tokenTypeForCexAsset } from '../../core/utils/fiat-codes';
import { splitConcatenatedPair } from '../../core/utils/symbol-splitter';
import { mexcManifest } from './manifest';

export { mexcManifest } from './manifest';

const MEXC_INSTITUTION_CODE = 'mexc';
const RECV_WINDOW = 5000;

const TX_QUOTE_ASSETS = [
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'BTC',
  'ETH',
  'EUR',
  'GBP',
  'TRY',
] as const;
const MAX_CANDIDATE_SYMBOLS = 50;
const TRADES_PAGE_SIZE = 1000;
const CAPITAL_PAGE_SIZE = 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const MAX_TRADE_PAGES_PER_WINDOW = 200;

interface MexcBalance {
  asset: string;
  free: string;
  locked: string;
}

interface MexcTrade {
  symbol: string;
  id: string;
  orderId: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

interface MexcDeposit {
  amount: string;
  coin: string;
  network?: string;
  status: number;
  txId?: string;
  insertTime: number;
}

interface MexcWithdraw {
  id?: string;
  amount: string;
  transactionFee?: string;
  coin: string;
  status: number;
  txId?: string;
  /** MEXC returns unix-ms; legacy strings tolerated like Binance. */
  applyTime: number | string;
}

export class MexcProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'mexc';
  readonly manifest = mexcManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = 'https://api.mexc.com';

  // MEXC puts the signature in the query string itself. signRequest just
  // contributes the API-key header — the subclass builds the signed
  // query via `signedQueryString` before calling signedJson.
  protected signRequest(_req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    return { 'X-MEXC-APIKEY': creds.apiKey };
  }

  private signedQueryString(apiSecret: string, params: Record<string, unknown> = {}): string {
    const timestamp = Date.now();
    const all = { timestamp, recvWindow: RECV_WINDOW, ...params };
    const qs = Object.entries(all)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${sig}`;
  }

  canFetchBalances(c: string): boolean {
    return c === MEXC_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === MEXC_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const balances = await this.fetchSpot(creds);

    const out: HoldingSnapshot[] = [];
    for (const b of balances) {
      const total = new Decimal(b.free || '0').plus(b.locked || '0');
      if (total.lte(0)) continue;
      const tokenIdentity: Partial<NewToken> = {
        symbol: b.asset.toUpperCase(),
        name: b.asset,
        providerMetadata: { mexc: { asset: b.asset } },
      };
      out.push({
        externalId: b.asset,
        tokenIdentity,
        balance: total.toString(),
        capturedAt: new Date(),
        tokenType: tokenTypeForCexAsset(b.asset),
      });
    }
    return out;
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
    const since = ctx.since ?? new Date(until.getTime() - FIVE_YEARS_MS);

    const balances = await this.fetchSpot(creds).catch(() => []);
    const heldAssets = new Set<string>();
    for (const b of balances) {
      const total = new Decimal(b.free || '0').plus(b.locked || '0');
      if (total.gt(0)) heldAssets.add(b.asset.toUpperCase());
    }

    const events: TransactionEvent[] = [];

    const symbols = this.buildCandidateSymbols(heldAssets);
    for (const symbol of symbols) {
      const trades = await this.fetchAllTradesForSymbol(creds, symbol, since, until).catch(
        () => []
      );
      for (const trade of trades) {
        const event = this.tradeToEvent(trade);
        if (event) events.push(event);
      }
    }

    for (const asset of heldAssets) {
      const deposits = await this.fetchAllDeposits(creds, asset, since, until).catch(() => []);
      for (const dep of deposits) events.push(this.depositToEvent(dep));
      const withdraws = await this.fetchAllWithdraws(creds, asset, since, until).catch(() => []);
      for (const w of withdraws) events.push(this.withdrawToEvent(w));
    }

    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== MEXC_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };
    try {
      const query = this.signedQueryString(apiSecret);
      await this.signedFetch(
        { method: 'GET', url: '/api/v3/account', query },
        { apiKey, apiSecret }
      );
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchSpot(creds: ApiKeyCreds): Promise<MexcBalance[]> {
    const query = this.signedQueryString(creds.apiSecret);
    const data = await this.signedJson<{ balances?: MexcBalance[] }>(
      { method: 'GET', url: '/api/v3/account', query },
      creds
    );
    return data.balances ?? [];
  }

  private buildCandidateSymbols(heldAssets: ReadonlySet<string>): string[] {
    const quoteSet = new Set<string>(TX_QUOTE_ASSETS);
    const out: string[] = [];
    for (const base of heldAssets) {
      for (const quote of TX_QUOTE_ASSETS) {
        if (base === quote) continue;
        out.push(`${base}${quote}`);
        if (out.length >= MAX_CANDIDATE_SYMBOLS) return out;
      }
    }
    // Reverse pairs where the held asset is the quote leg (user holds
    // USDT — try ETHUSDT, BTCUSDT). Bounded by the same cap so wide
    // stablecoin holdings don't blow it out.
    for (const quote of heldAssets) {
      if (!quoteSet.has(quote)) continue;
      for (const base of heldAssets) {
        if (base === quote) continue;
        const sym = `${base}${quote}`;
        if (out.includes(sym)) continue;
        out.push(sym);
        if (out.length >= MAX_CANDIDATE_SYMBOLS) return out;
      }
    }
    return out;
  }

  private async fetchAllTradesForSymbol(
    creds: ApiKeyCreds,
    symbol: string,
    since: Date,
    until: Date
  ): Promise<MexcTrade[]> {
    const all: MexcTrade[] = [];
    for (const window of this.iterateWindows(since, until, THIRTY_DAYS_MS)) {
      let fromId: string | undefined;
      for (let page = 0; page < MAX_TRADE_PAGES_PER_WINDOW; page++) {
        const params: Record<string, unknown> = {
          symbol,
          startTime: window.start.getTime(),
          endTime: window.end.getTime(),
          limit: TRADES_PAGE_SIZE,
        };
        if (fromId !== undefined) params.fromId = fromId;
        const query = this.signedQueryString(creds.apiSecret, params);
        const trades = await this.signedJson<MexcTrade[]>(
          { method: 'GET', url: '/api/v3/myTrades', query },
          creds
        );
        if (!Array.isArray(trades) || trades.length === 0) break;
        all.push(...trades);
        if (trades.length < TRADES_PAGE_SIZE) break;
        const lastId = trades[trades.length - 1]?.id;
        if (lastId === undefined) break;
        const next = this.advanceId(lastId);
        if (next === undefined) break;
        fromId = next;
      }
    }
    return all;
  }

  // MEXC's deposit/withdraw endpoints don't expose an explicit cursor:
  // we cap each window at one page and trust the 90-day limit + 1000-row
  // ceiling. If a user exceeds that we'd silently truncate — acceptable
  // until we see one in the wild.
  private async fetchAllDeposits(
    creds: ApiKeyCreds,
    asset: string,
    since: Date,
    until: Date
  ): Promise<MexcDeposit[]> {
    const out: MexcDeposit[] = [];
    for (const window of this.iterateWindows(since, until, NINETY_DAYS_MS)) {
      const query = this.signedQueryString(creds.apiSecret, {
        coin: asset,
        startTime: window.start.getTime(),
        endTime: window.end.getTime(),
        limit: CAPITAL_PAGE_SIZE,
      });
      const page$ = await this.signedJson<MexcDeposit[]>(
        { method: 'GET', url: '/api/v3/capital/deposit/hisrec', query },
        creds
      );
      if (Array.isArray(page$)) out.push(...page$);
    }
    return out;
  }

  private async fetchAllWithdraws(
    creds: ApiKeyCreds,
    asset: string,
    since: Date,
    until: Date
  ): Promise<MexcWithdraw[]> {
    const out: MexcWithdraw[] = [];
    for (const window of this.iterateWindows(since, until, NINETY_DAYS_MS)) {
      const query = this.signedQueryString(creds.apiSecret, {
        coin: asset,
        startTime: window.start.getTime(),
        endTime: window.end.getTime(),
        limit: CAPITAL_PAGE_SIZE,
      });
      const page$ = await this.signedJson<MexcWithdraw[]>(
        { method: 'GET', url: '/api/v3/capital/withdraw/history', query },
        creds
      );
      if (Array.isArray(page$)) out.push(...page$);
    }
    return out;
  }

  private *iterateWindows(
    since: Date,
    until: Date,
    spanMs: number
  ): Generator<{ start: Date; end: Date }> {
    let cursor = since.getTime();
    const endMs = until.getTime();
    while (cursor < endMs) {
      const next = Math.min(cursor + spanMs, endMs);
      yield { start: new Date(cursor), end: new Date(next) };
      cursor = next;
    }
  }

  // MEXC trade ids are documented as numeric but some accounts see
  // strings (large ids). Try numeric increment; fall back to undefined
  // so the loop terminates rather than re-fetching the same page.
  private advanceId(id: string): string | undefined {
    const n = Number(id);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
    return String(n + 1);
  }

  private tradeToEvent(trade: MexcTrade): TransactionEvent | null {
    const split = splitConcatenatedPair(trade.symbol, TX_QUOTE_ASSETS);
    if (!split) return null;
    const kind = trade.isBuyer ? 'buy' : 'sell';
    const primaryQty = enforceSign(trade.qty, kind);
    const counterQty = inferCounterSign(primaryQty, trade.quoteQty);

    const event: TransactionEvent = {
      externalId: `${trade.symbol}-${trade.id}`,
      occurredAt: new Date(trade.time),
      kind,
      primary: {
        tokenIdentity: this.assetIdentity(split.base),
        quantity: primaryQty,
      },
      counter: {
        tokenIdentity: this.assetIdentity(split.quote),
        quantity: counterQty,
      },
      rawPayload: trade,
    };
    if (trade.commission && new Decimal(trade.commission).gt(0) && trade.commissionAsset) {
      event.fee = {
        tokenIdentity: this.assetIdentity(trade.commissionAsset),
        quantity: negateFee(trade.commission),
      };
    }
    return event;
  }

  private depositToEvent(dep: MexcDeposit): TransactionEvent {
    const externalId = `${dep.coin}-${dep.insertTime}-${dep.txId ?? ''}`;
    return {
      externalId,
      occurredAt: new Date(dep.insertTime),
      kind: 'deposit',
      primary: {
        tokenIdentity: this.assetIdentity(dep.coin),
        quantity: enforceSign(dep.amount, 'deposit'),
      },
      rawPayload: dep,
    };
  }

  private withdrawToEvent(w: MexcWithdraw): TransactionEvent {
    const ts =
      typeof w.applyTime === 'number'
        ? w.applyTime
        : Date.parse(`${w.applyTime.replace(' ', 'T')}Z`);
    const externalId = `${w.coin}-${ts}-${w.txId ?? w.id ?? ''}`;
    const event: TransactionEvent = {
      externalId,
      occurredAt: new Date(ts),
      kind: 'withdraw',
      primary: {
        tokenIdentity: this.assetIdentity(w.coin),
        quantity: enforceSign(w.amount, 'withdraw'),
      },
      rawPayload: w,
    };
    if (w.transactionFee && new Decimal(w.transactionFee).gt(0)) {
      event.fee = {
        tokenIdentity: this.assetIdentity(w.coin),
        quantity: negateFee(w.transactionFee),
      };
    }
    return event;
  }

  private assetIdentity(asset: string): Partial<NewToken> {
    const symbol = asset.toUpperCase();
    return {
      symbol,
      name: symbol,
      providerMetadata: { mexc: { asset: symbol } },
    };
  }
}

export const mexcFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'mexc-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'mexc-private',
    limiter,
    registeredFrom: 'providers/mexc',
    description: 'MEXC: 10 req / 1s per API key',
  });
  return new MexcProvider(registered);
};
