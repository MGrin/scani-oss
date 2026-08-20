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
import { credentialRejection, ProviderError } from '../../core/errors';
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
import { slidingWindows } from '../../core/utils/time-windows';
import { binanceManifest } from './manifest';

export { binanceManifest } from './manifest';

const BINANCE_INSTITUTION_CODE = 'binance';
const RECV_WINDOW = 5000;

const TX_QUOTE_ASSETS = [
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'BTC',
  'ETH',
  'BNB',
  'EUR',
  'GBP',
  'TRY',
] as const;
const MAX_CANDIDATE_SYMBOLS = 50;
const TRADES_PAGE_SIZE = 1000;
const CAPITAL_PAGE_SIZE = 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
// Binance C2C endpoint caps each query to a 30-day window.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const MAX_TRADE_PAGES = 200;
const MAX_CAPITAL_PAGES_PER_WINDOW = 50;
const C2C_PAGE_SIZE = 100;
const C2C_TRADE_TYPES = ['BUY', 'SELL'] as const;

/**
 * Binance reports "this API key cannot see this wallet" as a code in the
 * JSON error body, not as a distinct HTTP status — a permission refusal
 * and a WAF block are both 4xx. Codes per
 * https://developers.binance.com/docs/margin_trading/error-code:
 *
 *   -2015 REJECTED_MBX_KEY         "Invalid API-key, IP, or permissions for action."
 *   -3003 NO_OPENED_MARGIN_ACCOUNT "Margin account does not exist."
 *
 * -2015 also covers a wholly invalid key and an IP-allowlist miss. That
 * is safe here because it is only tolerated on the opt-in wallets: a key
 * that is invalid outright fails the Spot read too, and Spot propagates.
 */
const INACCESSIBLE_WALLET_CODES: ReadonlySet<number> = new Set([-2015, -3003]);

function inaccessibleWallet(err: unknown): boolean {
  if (!(err instanceof ProviderError) || !err.body) return false;
  try {
    const { code } = JSON.parse(err.body) as { code?: unknown };
    return typeof code === 'number' && INACCESSIBLE_WALLET_CODES.has(code);
  } catch {
    return false;
  }
}

interface BinanceWalletBalance {
  asset: string;
  free: string;
  locked: string;
}

interface BinanceSpotResponse {
  balances?: BinanceWalletBalance[];
}
interface BinanceMarginResponse {
  userAssets?: BinanceWalletBalance[];
}

interface BinanceTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

interface BinanceDeposit {
  amount: string;
  coin: string;
  network?: string;
  status: number;
  txId?: string;
  insertTime: number;
}

interface BinanceWithdraw {
  id?: string;
  amount: string;
  transactionFee?: string;
  coin: string;
  status: number;
  txId?: string;
  /** Recent API returns a unix-ms number; some legacy responses still
      ship "yyyy-MM-dd HH:mm:ss" UTC strings. */
  applyTime: number | string;
}

interface BinanceFundingAsset {
  asset: string;
  /** Available balance in Funding wallet. */
  free: string;
  /** Standard "locked in open order" leg. */
  locked: string;
  /** Frozen by security/admin action. Still the user's funds. */
  freeze?: string;
  /** In-flight withdrawal. Still the user's funds until settled. */
  withdrawing?: string;
}

interface BinanceC2COrder {
  orderNumber: string;
  advNo?: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiat: string;
  fiatSymbol?: string;
  /** Crypto-leg quantity. */
  amount: string;
  /** Fiat-leg quantity. */
  totalPrice: string;
  unitPrice?: string;
  orderStatus: string;
  createTime: number;
  /** Crypto-leg commission Binance charges. */
  commission?: string;
}

interface BinanceC2CResponse {
  code?: string;
  message?: string | null;
  data?: BinanceC2COrder[];
  total?: number;
  success?: boolean;
}

export class BinanceProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'binance';
  readonly manifest = binanceManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  // A `since`-less run does not reach the account's start: it substitutes
  // `until - FIVE_YEARS_MS` and every deposit, withdrawal and P2P order walk
  // is bounded by it. Declared so the router stops claiming a complete history
  // over an account older than that — the same substitution Bybit and Bitget
  // declare, five years out instead of thirty days (SC-418, SC-166).
  //
  // It is what the `since`-less call ACTUALLY reaches, not the furthest
  // Binance would go if asked, which is the rule `capabilities.ts` states.
  readonly transactionHistoryHorizonMs = FIVE_YEARS_MS;
  protected readonly baseUrl: string;

  constructor(limiter: OutflowRateLimiter, baseUrl = 'https://api.binance.com') {
    super(limiter);
    this.baseUrl = baseUrl;
  }

  // Binance puts the signature in the query string itself; signRequest
  // contributes only the API-key header.
  protected signRequest(_req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    return { 'X-MBX-APIKEY': creds.apiKey };
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
    return c === BINANCE_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === BINANCE_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    // Margin + Funding permissions are opt-in per-key, so a key without
    // them must not fail the whole sync — but only a *refusal* may be
    // read as "no such account here". Any other failure propagates: an
    // empty wallet is indistinguishable from a real zero downstream, and
    // HoldingsSyncHelper zeroes every holding sourced from it (SC-237).
    // Spot is not opt-in and is never tolerated.
    // Funding is the C2C / Pay wallet — P2P sells lock the crypto leg
    // here, Binance Pay receipts land here, and the assets are invisible
    // to Spot/Margin balance reads.
    const [spot, margin, funding] = await Promise.all([
      this.fetchSpot(creds),
      this.optionalWallet('margin', () => this.fetchMargin(creds)),
      this.optionalWallet('funding', () => this.fetchFunding(creds)),
    ]);

    const combined = new Map<string, { free: string; locked: string }>();
    for (const b of [...spot, ...margin, ...funding]) {
      const existing = combined.get(b.asset);
      if (existing) {
        const free = new Decimal(existing.free).plus(b.free).toString();
        const locked = new Decimal(existing.locked).plus(b.locked).toString();
        combined.set(b.asset, { free, locked });
      } else {
        combined.set(b.asset, { free: b.free, locked: b.locked });
      }
    }

    const out: HoldingSnapshot[] = [];
    for (const [asset, { free, locked }] of combined) {
      const total = new Decimal(free).plus(locked);
      if (total.lte(0)) continue;
      const tokenIdentity: Partial<NewToken> = {
        symbol: asset.toUpperCase(),
        name: asset,
        providerMetadata: { binance: { asset } },
      };
      out.push({
        externalId: asset,
        tokenIdentity,
        balance: total.toString(),
        capturedAt: new Date(),
        tokenType: tokenTypeForCexAsset(asset),
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

    const [spot, margin, funding] = await Promise.all([
      this.fetchSpot(creds).catch(() => []),
      this.fetchMargin(creds).catch(() => []),
      this.fetchFunding(creds).catch(() => []),
    ]);
    const heldAssets = new Set<string>();
    for (const b of [...spot, ...margin, ...funding]) {
      const total = new Decimal(b.free).plus(b.locked);
      if (total.gt(0)) heldAssets.add(b.asset.toUpperCase());
    }

    const events: TransactionEvent[] = [];

    const symbols = this.buildCandidateSymbols(heldAssets);
    for (const symbol of symbols) {
      const trades = await this.fetchAllTradesForSymbol(creds, symbol).catch(() => []);
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

    // C2C (P2P) orders are reported via a separate endpoint that's keyed
    // by tradeType + time window, not by asset — wrap the whole branch
    // in catch so a key without C2C permission still imports trades +
    // capital deposits + withdraws.
    const p2pOrders = await this.fetchAllP2POrders(creds, since, until).catch(() => []);
    for (const order of p2pOrders) {
      const event = this.p2pOrderToEvent(order);
      if (event) events.push(event);
    }

    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== BINANCE_INSTITUTION_CODE) {
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
      return credentialRejection(err);
    }
  }

  private async optionalWallet(
    wallet: 'margin' | 'funding',
    read: () => Promise<BinanceWalletBalance[]>
  ): Promise<BinanceWalletBalance[]> {
    try {
      return await read();
    } catch (err) {
      if (!inaccessibleWallet(err)) throw err;
      this.logger.debug({ wallet }, 'Binance wallet not accessible for this API key');
      return [];
    }
  }

  private async fetchSpot(creds: ApiKeyCreds): Promise<BinanceWalletBalance[]> {
    const query = this.signedQueryString(creds.apiSecret);
    const data = await this.signedJson<BinanceSpotResponse>(
      { method: 'GET', url: '/api/v3/account', query },
      creds
    );
    return data.balances ?? [];
  }

  private async fetchMargin(creds: ApiKeyCreds): Promise<BinanceWalletBalance[]> {
    const query = this.signedQueryString(creds.apiSecret);
    const data = await this.signedJson<BinanceMarginResponse>(
      { method: 'GET', url: '/sapi/v1/margin/account', query },
      creds
    );
    return data.userAssets ?? [];
  }

  // Funding wallet (C2C / Pay). `freeze` + `withdrawing` are escrowed
  // legs of in-flight P2P orders / pending withdrawals — still owned by
  // the user, so we roll them into `locked` for the combined balance.
  private async fetchFunding(creds: ApiKeyCreds): Promise<BinanceWalletBalance[]> {
    const query = this.signedQueryString(creds.apiSecret);
    const rows = await this.signedJson<BinanceFundingAsset[]>(
      { method: 'POST', url: '/sapi/v1/asset/get-funding-asset', query },
      creds
    );
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      asset: row.asset,
      free: row.free,
      locked: new Decimal(row.locked ?? 0)
        .plus(row.freeze ?? 0)
        .plus(row.withdrawing ?? 0)
        .toString(),
    }));
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
    // Also include reverse pairs where the held asset is the quote leg
    // (e.g. user holds USDT — try ETHUSDT, BTCUSDT). Bounded by the same
    // cap so a wide spread of stablecoin holdings doesn't blow it out.
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
    symbol: string
  ): Promise<BinanceTrade[]> {
    const all: BinanceTrade[] = [];
    let fromId = 0;
    for (let page = 0; page < MAX_TRADE_PAGES; page++) {
      const query = this.signedQueryString(creds.apiSecret, {
        symbol,
        limit: TRADES_PAGE_SIZE,
        fromId,
      });
      const trades = await this.signedJson<BinanceTrade[]>(
        { method: 'GET', url: '/api/v3/myTrades', query },
        creds
      );
      if (!Array.isArray(trades) || trades.length === 0) break;
      all.push(...trades);
      const lastId = trades[trades.length - 1]?.id;
      if (lastId === undefined) break;
      fromId = lastId + 1;
    }
    return all;
  }

  private async fetchAllDeposits(
    creds: ApiKeyCreds,
    asset: string,
    since: Date,
    until: Date
  ): Promise<BinanceDeposit[]> {
    const out: BinanceDeposit[] = [];
    for (const window of this.iterate90DayWindows(since, until)) {
      let offset = 0;
      for (let page = 0; page < MAX_CAPITAL_PAGES_PER_WINDOW; page++) {
        const query = this.signedQueryString(creds.apiSecret, {
          coin: asset,
          startTime: window.start.getTime(),
          endTime: window.end.getTime(),
          offset,
          limit: CAPITAL_PAGE_SIZE,
        });
        const page$ = await this.signedJson<BinanceDeposit[]>(
          { method: 'GET', url: '/sapi/v1/capital/deposit/hisrec', query },
          creds
        );
        if (!Array.isArray(page$) || page$.length === 0) break;
        out.push(...page$);
        if (page$.length < CAPITAL_PAGE_SIZE) break;
        offset += page$.length;
      }
    }
    return out;
  }

  private async fetchAllWithdraws(
    creds: ApiKeyCreds,
    asset: string,
    since: Date,
    until: Date
  ): Promise<BinanceWithdraw[]> {
    const out: BinanceWithdraw[] = [];
    for (const window of this.iterate90DayWindows(since, until)) {
      let offset = 0;
      for (let page = 0; page < MAX_CAPITAL_PAGES_PER_WINDOW; page++) {
        const query = this.signedQueryString(creds.apiSecret, {
          coin: asset,
          startTime: window.start.getTime(),
          endTime: window.end.getTime(),
          offset,
          limit: CAPITAL_PAGE_SIZE,
        });
        const page$ = await this.signedJson<BinanceWithdraw[]>(
          { method: 'GET', url: '/sapi/v1/capital/withdraw/history', query },
          creds
        );
        if (!Array.isArray(page$) || page$.length === 0) break;
        out.push(...page$);
        if (page$.length < CAPITAL_PAGE_SIZE) break;
        offset += page$.length;
      }
    }
    return out;
  }

  private *iterate90DayWindows(since: Date, until: Date): Generator<{ start: Date; end: Date }> {
    yield* slidingWindows(since, until, NINETY_DAYS_MS);
  }

  private async fetchAllP2POrders(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): Promise<BinanceC2COrder[]> {
    const out: BinanceC2COrder[] = [];
    for (const window of slidingWindows(since, until, THIRTY_DAYS_MS)) {
      for (const tradeType of C2C_TRADE_TYPES) {
        for (let page = 1; page <= MAX_CAPITAL_PAGES_PER_WINDOW; page++) {
          const query = this.signedQueryString(creds.apiSecret, {
            tradeType,
            startTimestamp: window.start.getTime(),
            endTimestamp: window.end.getTime(),
            page,
            rows: C2C_PAGE_SIZE,
          });
          const response = await this.signedJson<BinanceC2CResponse>(
            { method: 'GET', url: '/sapi/v1/c2c/orderMatch/listUserOrderHistory', query },
            creds
          );
          const rows = response.data ?? [];
          if (rows.length === 0) break;
          out.push(...rows);
          if (rows.length < C2C_PAGE_SIZE) break;
        }
      }
    }
    return out;
  }

  private tradeToEvent(trade: BinanceTrade): TransactionEvent | null {
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

  private depositToEvent(dep: BinanceDeposit): TransactionEvent {
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

  // P2P (C2C) fills resemble spot trades but settle off-orderbook
  // against a counterparty in fiat. tradeType=BUY means the user
  // received crypto in exchange for fiat (kind='buy'), SELL is the
  // reverse. The crypto leg's commission is debited from the user.
  // Non-COMPLETED orders never settle — drop them so they don't
  // fabricate a funds-flow that never happened.
  private p2pOrderToEvent(order: BinanceC2COrder): TransactionEvent | null {
    if (order.orderStatus !== 'COMPLETED') return null;
    const kind = order.tradeType === 'BUY' ? 'buy' : 'sell';
    const primaryQty = enforceSign(order.amount, kind);
    const counterQty = inferCounterSign(primaryQty, order.totalPrice);

    const event: TransactionEvent = {
      externalId: `c2c-${order.orderNumber}`,
      occurredAt: new Date(order.createTime),
      kind,
      primary: {
        tokenIdentity: this.assetIdentity(order.asset),
        quantity: primaryQty,
      },
      counter: {
        tokenIdentity: this.assetIdentity(order.fiat),
        quantity: counterQty,
      },
      rawPayload: order,
    };
    if (order.commission && new Decimal(order.commission).gt(0)) {
      event.fee = {
        tokenIdentity: this.assetIdentity(order.asset),
        quantity: negateFee(order.commission),
      };
    }
    return event;
  }

  private withdrawToEvent(w: BinanceWithdraw): TransactionEvent {
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
      providerMetadata: { binance: { asset: symbol } },
    };
  }
}

export const binanceFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 20,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'binance-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'binance-private',
    limiter,
    registeredFrom: 'providers/binance',
    description: 'Binance private: 20 req / 1s per API key',
  });
  return new BinanceProvider(registered, deps.env.SCANI_TESTNET_BINANCE_BASE_URL || undefined);
};
