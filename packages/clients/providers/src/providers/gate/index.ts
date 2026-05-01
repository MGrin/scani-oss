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
import { gateManifest } from './manifest';

export { gateManifest } from './manifest';

const GATE_INSTITUTION_CODE = 'gate';

// Candidate quote suffixes for building my_trades pair queries from a
// held-asset list. Order is informational only — Gate uses a delimiter
// (`BTC_USDT`) so there's no greedy split heuristic to worry about.
const TX_QUOTE_ASSETS = ['USDT', 'USDC', 'BTC', 'ETH', 'USD', 'EUR', 'GBP', 'TRY', 'BUSD'] as const;

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const TRADES_PAGE_LIMIT = 1000;
const LEDGER_PAGE_LIMIT = 1000;
const WALLET_PAGE_LIMIT = 500;
const MAX_CANDIDATE_PAIRS = 80;
const MAX_TRADE_PAGES = 200;
const MAX_LEDGER_PAGES = 200;
const MAX_WALLET_PAGES = 50;

interface GateSpotBalance {
  currency: string;
  available: string;
  locked: string;
}

interface GateTrade {
  id: string;
  create_time: string;
  create_time_ms?: string;
  currency_pair: string;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  fee?: string;
  fee_currency?: string;
  order_id?: string;
}

interface GateLedgerRow {
  id: string;
  time: string;
  currency: string;
  change: string;
  balance: string;
  type: 'trade' | 'deposit' | 'withdraw' | 'fee' | 'transfer' | string;
  text?: string;
}

interface GateWalletDeposit {
  id?: string;
  txid?: string;
  amount: string;
  currency: string;
  address?: string;
  chain?: string;
  timestamp: string;
  status?: string;
}

interface GateWalletWithdrawal {
  id?: string;
  txid?: string;
  amount: string;
  currency: string;
  address?: string;
  chain?: string;
  fee?: string;
  timestamp: string;
  status?: string;
}

export class GateProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'gate';
  readonly manifest = gateManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = 'https://api.gateio.ws/api/v4';

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hashedBody = crypto
      .createHash('sha512')
      .update(req.body ?? '')
      .digest('hex');
    const preSign = `${req.method}\n/api/v4${req.url}\n${req.query ?? ''}\n${hashedBody}\n${timestamp}`;
    const signature = crypto.createHmac('sha512', creds.apiSecret).update(preSign).digest('hex');
    return {
      KEY: creds.apiKey,
      SIGN: signature,
      Timestamp: timestamp,
      'Content-Type': 'application/json',
    };
  }

  canFetchBalances(c: string): boolean {
    return c === GATE_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === GATE_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const balances = await this.fetchSpotBalances(creds);

    const out: HoldingSnapshot[] = [];
    for (const b of balances) {
      const total = new Decimal(b.available || '0').plus(b.locked || '0');
      if (total.lte(0)) continue;
      out.push({
        externalId: b.currency,
        tokenIdentity: this.assetIdentity(b.currency),
        balance: total.toString(),
        capturedAt: new Date(),
      });
    }
    return out;
  }

  /**
   * Strategy:
   *   1. /spot/accounts/ledger per held currency — primary "single feed"
   *      covering trade/deposit/withdraw/fee/transfer rows. We emit
   *      fee + transfer events directly here; trade rows are skipped
   *      because the per-leg ledger view doesn't carry pair info, and
   *      deposit/withdraw rows are skipped because they don't carry a
   *      txid.
   *   2. /spot/my_trades per candidate pair — the authoritative source
   *      for trade events (gives us pair, price, counter-leg, fee).
   *      Candidate pairs come from held assets × known quote suffixes.
   *   3. /wallet/deposits + /wallet/withdrawals — txid-bearing source
   *      of truth for deposit/withdraw events.
   */
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

    const balances = await this.fetchSpotBalances(creds).catch(() => []);
    const heldAssets = new Set<string>();
    for (const b of balances) {
      const total = new Decimal(b.available || '0').plus(b.locked || '0');
      if (total.gt(0)) heldAssets.add(b.currency.toUpperCase());
    }

    const events: TransactionEvent[] = [];

    for (const currency of heldAssets) {
      const rows = await this.paginateLedger(creds, currency, since, until).catch(() => []);
      for (const row of rows) {
        if (row.type === 'fee') {
          events.push(this.ledgerFeeToEvent(row));
        } else if (row.type === 'transfer') {
          events.push(this.ledgerTransferToEvent(row));
        }
      }
    }

    const pairs = this.buildCandidatePairs(heldAssets);
    for (const pair of pairs) {
      const trades = await this.paginateMyTrades(creds, pair, since, until).catch(() => []);
      for (const t of trades) {
        const ev = this.tradeToEvent(t);
        if (ev) events.push(ev);
      }
    }

    const deposits = await this.paginateDeposits(creds, since, until).catch(() => []);
    for (const d of deposits) events.push(this.depositToEvent(d));

    const withdrawals = await this.paginateWithdrawals(creds, since, until).catch(() => []);
    for (const w of withdrawals) events.push(this.withdrawToEvent(w));

    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== GATE_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };
    try {
      await this.signedFetch({ method: 'GET', url: '/spot/accounts' }, { apiKey, apiSecret });
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchSpotBalances(creds: ApiKeyCreds): Promise<GateSpotBalance[]> {
    const balances = await this.signedJson<GateSpotBalance[]>(
      { method: 'GET', url: '/spot/accounts' },
      creds
    );
    return Array.isArray(balances) ? balances : [];
  }

  private buildCandidatePairs(held: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (pair: string): boolean => {
      if (seen.has(pair)) return false;
      seen.add(pair);
      out.push(pair);
      return out.length < MAX_CANDIDATE_PAIRS;
    };
    for (const base of held) {
      for (const quote of TX_QUOTE_ASSETS) {
        if (base === quote) continue;
        if (!push(`${base}_${quote}`)) return out;
      }
    }
    // Held quote-asset legs (e.g. user holds USDT — try ETH_USDT, BTC_USDT
    // even when ETH/BTC are no longer in their wallet).
    const quoteSet = new Set<string>(TX_QUOTE_ASSETS);
    for (const quote of held) {
      if (!quoteSet.has(quote)) continue;
      for (const base of held) {
        if (base === quote) continue;
        if (!push(`${base}_${quote}`)) return out;
      }
    }
    return out;
  }

  private async paginateMyTrades(
    creds: ApiKeyCreds,
    pair: string,
    since: Date,
    until: Date
  ): Promise<GateTrade[]> {
    const all: GateTrade[] = [];
    let lastId: string | undefined;
    for (let page = 0; page < MAX_TRADE_PAGES; page += 1) {
      const params = new URLSearchParams({
        currency_pair: pair,
        limit: String(TRADES_PAGE_LIMIT),
        from: String(Math.floor(since.getTime() / 1000)),
        to: String(Math.floor(until.getTime() / 1000)),
      });
      if (lastId) params.set('last_id', lastId);
      const trades = await this.signedJson<GateTrade[]>(
        { method: 'GET', url: '/spot/my_trades', query: params.toString() },
        creds
      );
      if (!Array.isArray(trades) || trades.length === 0) break;
      all.push(...trades);
      if (trades.length < TRADES_PAGE_LIMIT) break;
      const next = trades[trades.length - 1]?.id;
      if (!next || next === lastId) break;
      lastId = next;
    }
    return all;
  }

  private async paginateLedger(
    creds: ApiKeyCreds,
    currency: string,
    since: Date,
    until: Date
  ): Promise<GateLedgerRow[]> {
    const all: GateLedgerRow[] = [];
    let pageNum = 1;
    for (let page = 0; page < MAX_LEDGER_PAGES; page += 1) {
      const params = new URLSearchParams({
        currency,
        limit: String(LEDGER_PAGE_LIMIT),
        from: String(Math.floor(since.getTime() / 1000)),
        to: String(Math.floor(until.getTime() / 1000)),
        page: String(pageNum),
      });
      const rows = await this.signedJson<GateLedgerRow[]>(
        { method: 'GET', url: '/spot/accounts/ledger', query: params.toString() },
        creds
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < LEDGER_PAGE_LIMIT) break;
      pageNum += 1;
    }
    return all;
  }

  private async paginateDeposits(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): Promise<GateWalletDeposit[]> {
    const all: GateWalletDeposit[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_WALLET_PAGES; page += 1) {
      const params = new URLSearchParams({
        limit: String(WALLET_PAGE_LIMIT),
        offset: String(offset),
        from: String(Math.floor(since.getTime() / 1000)),
        to: String(Math.floor(until.getTime() / 1000)),
      });
      const rows = await this.signedJson<GateWalletDeposit[]>(
        { method: 'GET', url: '/wallet/deposits', query: params.toString() },
        creds
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < WALLET_PAGE_LIMIT) break;
      offset += rows.length;
    }
    return all;
  }

  private async paginateWithdrawals(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): Promise<GateWalletWithdrawal[]> {
    const all: GateWalletWithdrawal[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_WALLET_PAGES; page += 1) {
      const params = new URLSearchParams({
        limit: String(WALLET_PAGE_LIMIT),
        offset: String(offset),
        from: String(Math.floor(since.getTime() / 1000)),
        to: String(Math.floor(until.getTime() / 1000)),
      });
      const rows = await this.signedJson<GateWalletWithdrawal[]>(
        { method: 'GET', url: '/wallet/withdrawals', query: params.toString() },
        creds
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < WALLET_PAGE_LIMIT) break;
      offset += rows.length;
    }
    return all;
  }

  private tradeToEvent(trade: GateTrade): TransactionEvent | null {
    const split = this.splitPair(trade.currency_pair);
    if (!split) return null;
    const kind = trade.side === 'buy' ? 'buy' : 'sell';
    const primaryQty = enforceSign(trade.amount, kind);
    const counterAbs = new Decimal(trade.amount).times(trade.price || '0').toString();
    const counterQty = inferCounterSign(primaryQty, counterAbs);

    const event: TransactionEvent = {
      externalId: `${trade.currency_pair}-${trade.id}`,
      occurredAt: this.parseTradeTime(trade),
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
    if (trade.fee && new Decimal(trade.fee).gt(0)) {
      const feeCurrency = trade.fee_currency || split.quote;
      event.fee = {
        tokenIdentity: this.assetIdentity(feeCurrency),
        quantity: negateFee(trade.fee),
      };
    }
    if (trade.price && new Decimal(trade.price).gt(0)) {
      event.priceNative = {
        value: trade.price,
        quoteIdentity: this.assetIdentity(split.quote),
      };
    }
    return event;
  }

  private ledgerFeeToEvent(row: GateLedgerRow): TransactionEvent {
    const change = row.change || '0';
    return {
      externalId: `ledger-${row.id}`,
      occurredAt: this.parseLedgerTime(row.time),
      kind: 'fee',
      primary: {
        tokenIdentity: this.assetIdentity(row.currency),
        quantity: enforceSign(change, 'fee'),
      },
      rawPayload: row,
    };
  }

  // Sub-account transfers don't have a token counterparty; emit as
  // 'unknown' so the orchestrator records the leg without inventing a
  // synthetic counter. Sign comes straight from `change`.
  private ledgerTransferToEvent(row: GateLedgerRow): TransactionEvent {
    return {
      externalId: `ledger-${row.id}`,
      occurredAt: this.parseLedgerTime(row.time),
      kind: 'unknown',
      primary: {
        tokenIdentity: this.assetIdentity(row.currency),
        quantity: row.change || '0',
      },
      rawPayload: row,
    };
  }

  private depositToEvent(d: GateWalletDeposit): TransactionEvent {
    const idPart = d.txid && d.txid.length > 0 ? d.txid : d.id || d.timestamp;
    return {
      externalId: `dep-${d.currency}-${idPart}`,
      occurredAt: this.parseLedgerTime(d.timestamp),
      kind: 'deposit',
      primary: {
        tokenIdentity: this.assetIdentity(d.currency),
        quantity: enforceSign(d.amount, 'deposit'),
      },
      rawPayload: d,
    };
  }

  private withdrawToEvent(w: GateWalletWithdrawal): TransactionEvent {
    const idPart = w.txid && w.txid.length > 0 ? w.txid : w.id || w.timestamp;
    const event: TransactionEvent = {
      externalId: `wd-${w.currency}-${idPart}`,
      occurredAt: this.parseLedgerTime(w.timestamp),
      kind: 'withdraw',
      primary: {
        tokenIdentity: this.assetIdentity(w.currency),
        quantity: enforceSign(w.amount, 'withdraw'),
      },
      rawPayload: w,
    };
    if (w.fee && new Decimal(w.fee).gt(0)) {
      event.fee = {
        tokenIdentity: this.assetIdentity(w.currency),
        quantity: negateFee(w.fee),
      };
    }
    return event;
  }

  private splitPair(pair: string): { base: string; quote: string } | null {
    const parts = pair.split('_');
    if (parts.length !== 2) return null;
    const [base, quote] = parts;
    if (!base || !quote) return null;
    return { base: base.toUpperCase(), quote: quote.toUpperCase() };
  }

  private parseTradeTime(trade: GateTrade): Date {
    if (trade.create_time_ms) {
      const ms = Number.parseFloat(trade.create_time_ms);
      if (Number.isFinite(ms)) return new Date(ms);
    }
    const sec = Number.parseFloat(trade.create_time);
    return new Date(Number.isFinite(sec) ? sec * 1000 : Date.now());
  }

  // Gate.io ledger/wallet timestamps are seconds, sometimes with a
  // fractional component ('1572537065.123'). Wallet timestamps are
  // integer seconds.
  private parseLedgerTime(value: string): Date {
    const sec = Number.parseFloat(value);
    return new Date(Number.isFinite(sec) ? sec * 1000 : Date.now());
  }

  private assetIdentity(currency: string): Partial<NewToken> {
    const symbol = currency.toUpperCase();
    return {
      symbol,
      name: currency,
      providerMetadata: { gate: { currency } },
    };
  }
}

export const gateFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'gate-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'gate-private',
    limiter,
    registeredFrom: 'providers/gate',
    description: 'Gate.io: 10 req / 1s per API key',
  });
  return new GateProvider(registered);
};
