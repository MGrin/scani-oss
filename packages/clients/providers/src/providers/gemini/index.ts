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
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { tokenTypeForCexAsset } from '../../core/utils/fiat-codes';
import { PageCapWatch } from '../../core/utils/page-cap';
import { WalkFailureWatch } from '../../core/utils/walk-failures';
import { geminiManifest } from './manifest';

const GEMINI_INSTITUTION_CODE = 'gemini';

const TX_QUOTE_ASSETS = ['usd', 'usdt', 'btc'] as const;
const MYTRADES_PAGE_SIZE = 500;
const TRANSFERS_PAGE_SIZE = 50;
const MAX_TRADE_PAGES = 200;
const MAX_TRANSFER_PAGES = 200;
// Gemini opened to the public on 2015-10-25, so no account is older.
const GEMINI_LAUNCH_MS = Date.UTC(2015, 9, 25);
const SINCE_GEMINI_LAUNCH_MS = Date.now() - GEMINI_LAUNCH_MS;

interface GeminiBalance {
  currency: string;
  amount: string;
  type: string;
}

interface GeminiTrade {
  symbol?: string;
  price: string;
  amount: string;
  timestamp: number;
  timestampms: number;
  type: string;
  aggressor?: boolean;
  fee_currency?: string;
  fee_amount?: string;
  tid: number;
  order_id?: string;
  is_auction_fill?: boolean;
}

interface GeminiTransfer {
  type: string;
  status: string;
  timestampms: number;
  eid: number;
  currency: string;
  amount: string;
  method?: string;
  txHash?: string;
  destination?: string;
  purpose?: string;
}

interface GeminiSignedRequest extends SignedRequest {
  payloadExtras?: Record<string, unknown>;
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return {
    symbol,
    name: symbol,
    providerMetadata: { gemini: { currency: currency.toLowerCase() } },
  };
}

// reason "InvalidSymbol" = "Unknown or invalid symbol" — https://developer.gemini.com/error-codes.
// The page states the reason, not the status, so the REASON decides; the 4xx
// bound only keeps a 5xx body from being read as one.
function isInvalidSymbol(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.status === undefined || !err.body) return false;
  if (err.status < 400 || err.status >= 500) return false;
  try {
    const { reason } = JSON.parse(err.body) as { reason?: unknown };
    return reason === 'InvalidSymbol';
  } catch {
    return false;
  }
}

/**
 * Any other 4xx says the request itself is refused — a bad or under-scoped key
 * (401/403), a rate limit the limiter could not absorb (429). That fails every
 * walk the same way, so it fails the sync rather than being tolerated as one
 * missing walk (SC-1481). A 5xx stays a tolerated, retracted walk.
 */
function isRequestRefusal(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.status === undefined) return false;
  return err.status >= 400 && err.status < 500 && !isInvalidSymbol(err);
}

function splitGeminiSymbol(
  symbol: string,
  quotes: readonly string[]
): { base: string; quote: string } | null {
  const lower = symbol.toLowerCase();
  for (const quote of quotes) {
    if (lower.length <= quote.length) continue;
    if (lower.endsWith(quote)) {
      const base = lower.slice(0, lower.length - quote.length);
      if (!base) return null;
      return { base, quote };
    }
  }
  return null;
}

export class GeminiProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'gemini';
  readonly manifest = geminiManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  // Declared so the router never claims a complete history here, not because
  // the walk stops early: trades are asked for per symbol, and the symbols are
  // enumerated from balances and transfers, so an asset bought and sold to
  // zero without ever being deposited or withdrawn is never seen. That gap is
  // structural, so the claim must be too. The value is the true reach — the
  // walks are unbounded in time, and nothing on Gemini predates its launch.
  readonly transactionHistoryHorizonMs = SINCE_GEMINI_LAUNCH_MS;
  protected readonly baseUrl: string;

  constructor(limiter: OutflowRateLimiter, baseUrl = 'https://api.gemini.com') {
    super(limiter);
    this.baseUrl = baseUrl;
  }

  // Gemini packs the path + nonce + arbitrary params into a base64-JSON
  // payload header, signs the payload with HMAC-SHA384. Subclass-internal
  // callers thread per-endpoint params through `payloadExtras` on the
  // SignedRequest; signRequest merges those into the payload object before
  // base64 encoding.
  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const extras = (req as GeminiSignedRequest).payloadExtras ?? {};
    const payload = { ...extras, request: req.url, nonce: Date.now().toString() };
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = crypto
      .createHmac('sha384', creds.apiSecret)
      .update(base64Payload)
      .digest('hex');
    return {
      'X-GEMINI-APIKEY': creds.apiKey,
      'X-GEMINI-PAYLOAD': base64Payload,
      'X-GEMINI-SIGNATURE': signature,
      'Content-Type': 'text/plain',
      'Content-Length': '0',
      'Cache-Control': 'no-cache',
    };
  }

  canFetchBalances(c: string): boolean {
    return c === GEMINI_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === GEMINI_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const data = await this.signedJson<GeminiBalance[]>(
      { method: 'POST', url: '/v1/balances' },
      creds
    );
    if (!Array.isArray(data)) return [];

    return data
      .filter((b) => Number.parseFloat(b.amount) > 0)
      .map((b) => ({
        externalId: b.currency,
        tokenIdentity: tokenIdentity(b.currency),
        balance: b.amount,
        capturedAt: new Date(),
        tokenType: tokenTypeForCexAsset(b.currency),
      }));
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const capped = new PageCapWatch();
    const failures = new WalkFailureWatch(this.providerKey, this.logger);

    const balances = await failures.attempt(
      'the balance read',
      () => this.signedJson<GeminiBalance[]>({ method: 'POST', url: '/v1/balances' }, creds),
      [] as GeminiBalance[],
      isRequestRefusal
    );
    const assets = new Set<string>();
    if (Array.isArray(balances)) {
      for (const b of balances) {
        if (Number.parseFloat(b.amount) > 0) assets.add(b.currency.toLowerCase());
      }
    }

    // Transfers are walked first because they are the one feed Gemini lists
    // without a symbol: an asset deposited, traded and sold to zero is absent
    // from the balances above and would otherwise never have its trades asked
    // for (SC-1480).
    const transfers = await failures.attempt(
      'the transfers walk',
      () => this.fetchAllTransfers(creds, capped),
      [] as GeminiTransfer[],
      isRequestRefusal
    );
    for (const transfer of transfers) {
      if (transfer.currency) assets.add(transfer.currency.toLowerCase());
    }

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    const push = (event: TransactionEvent | null): void => {
      if (!event) return;
      if (seen.has(event.externalId)) return;
      seen.add(event.externalId);
      events.push(event);
    };

    for (const symbol of this.buildCandidateSymbols(assets)) {
      const trades = await failures.attempt(
        `the ${symbol} trades walk`,
        () => this.fetchAllTradesForSymbol(creds, symbol, capped),
        [] as GeminiTrade[],
        isRequestRefusal
      );
      for (const trade of trades) push(this.tradeToEvent(symbol, trade));
    }

    for (const transfer of transfers) push(this.transferToEvent(transfer));

    capped.retract(ctx, this.providerKey);
    failures.retract(ctx);
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== GEMINI_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };

    try {
      await this.signedFetch({ method: 'POST', url: '/v1/balances' }, { apiKey, apiSecret });
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  private buildCandidateSymbols(assets: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const base of assets) {
      for (const quote of TX_QUOTE_ASSETS) {
        if (base === quote) continue;
        const sym = `${base}${quote}`;
        if (seen.has(sym)) continue;
        seen.add(sym);
        out.push(sym);
      }
    }
    return out;
  }

  private async fetchAllTradesForSymbol(
    creds: ApiKeyCreds,
    symbol: string,
    capped: PageCapWatch
  ): Promise<GeminiTrade[]> {
    const all: GeminiTrade[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < MAX_TRADE_PAGES; page++) {
      const payloadExtras: Record<string, unknown> = {
        symbol,
        limit_trades: MYTRADES_PAGE_SIZE,
      };
      if (cursor !== undefined) payloadExtras.timestamp = cursor;
      const req: GeminiSignedRequest = {
        method: 'POST',
        url: '/v1/mytrades',
        payloadExtras,
      };
      let trades: GeminiTrade[];
      try {
        trades = await this.signedJson<GeminiTrade[]>(req, creds);
      } catch (err) {
        // A candidate pair Gemini does not list is an absent market, not a
        // failed walk: the candidates are a cross-product, so most runs ask
        // about several that do not exist.
        if (page === 0 && isInvalidSymbol(err)) return [];
        throw err;
      }
      if (!Array.isArray(trades) || trades.length === 0) break;
      all.push(...trades);
      const oldest = trades.reduce(
        (min, t) => (t.timestampms < min ? t.timestampms : min),
        trades[0]!.timestampms
      );
      const nextCursor = oldest - 1;
      if (cursor !== undefined && nextCursor >= cursor) break;
      cursor = nextCursor;
      if (trades.length < MYTRADES_PAGE_SIZE) break;
      // Last allowed page, and the cursor was still advancing into older
      // trades. Everything before this point is missing.
      if (page === MAX_TRADE_PAGES - 1) {
        capped.note({
          walk: { kind: 'symbolTrades', symbol },
          pages: MAX_TRADE_PAGES,
          rows: all.length,
        });
      }
    }
    return all;
  }

  private async fetchAllTransfers(
    creds: ApiKeyCreds,
    capped: PageCapWatch
  ): Promise<GeminiTransfer[]> {
    const all: GeminiTransfer[] = [];
    let continuationToken: string | undefined;
    for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
      const payloadExtras: Record<string, unknown> = {
        limit_transfers: TRANSFERS_PAGE_SIZE,
      };
      if (continuationToken) payloadExtras.continuation_token = continuationToken;
      const req: GeminiSignedRequest = {
        method: 'POST',
        url: '/v2/transfers',
        payloadExtras,
      };
      const res = await this.signedFetch(req, creds);
      const headerToken = res.headers.get('continuation_token');
      const rows = (await res.json()) as GeminiTransfer[];
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (!headerToken) break;
      if (headerToken === continuationToken) break;
      continuationToken = headerToken;
      if (page === MAX_TRANSFER_PAGES - 1) {
        capped.note({ walk: { kind: 'transfers' }, pages: MAX_TRANSFER_PAGES, rows: all.length });
      }
    }
    return all;
  }

  private tradeToEvent(symbol: string, trade: GeminiTrade): TransactionEvent | null {
    const split = splitGeminiSymbol(symbol, TX_QUOTE_ASSETS);
    if (!split) return null;
    const rawType = trade.type;
    const kind = rawType === 'Buy' ? 'buy' : rawType === 'Sell' ? 'sell' : null;
    if (!kind) return null;

    const amount = new Decimal(trade.amount);
    const price = new Decimal(trade.price);
    const counterAbs = amount.times(price).toString();

    const primaryQty = enforceSign(amount.toString(), kind);
    const counterQty = inferCounterSign(primaryQty, counterAbs);

    const event: TransactionEvent = {
      externalId: `trade-${symbol}-${trade.tid}`,
      occurredAt: new Date(trade.timestampms),
      kind,
      primary: {
        tokenIdentity: tokenIdentity(split.base),
        quantity: primaryQty,
      },
      counter: {
        tokenIdentity: tokenIdentity(split.quote),
        quantity: counterQty,
      },
      priceNative: {
        value: price.toString(),
        quoteIdentity: tokenIdentity(split.quote),
      },
      rawPayload: trade,
    };
    if (trade.fee_amount && new Decimal(trade.fee_amount).gt(0) && trade.fee_currency) {
      event.fee = {
        tokenIdentity: tokenIdentity(trade.fee_currency),
        quantity: negateFee(trade.fee_amount),
      };
    }
    return event;
  }

  private transferToEvent(transfer: GeminiTransfer): TransactionEvent | null {
    const kind =
      transfer.type === 'Deposit' ? 'deposit' : transfer.type === 'Withdrawal' ? 'withdraw' : null;
    if (!kind) return null;
    return {
      externalId: `transfer-${transfer.eid}`,
      occurredAt: new Date(transfer.timestampms),
      kind,
      primary: {
        tokenIdentity: tokenIdentity(transfer.currency),
        quantity: enforceSign(transfer.amount, kind),
      },
      rawPayload: transfer,
    };
  }
}

export const geminiFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'gemini-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'gemini-private',
    limiter,
    registeredFrom: 'providers/gemini',
    description: 'Gemini private: 5 req / 1s',
  });
  return new GeminiProvider(registered, deps.env.SCANI_TESTNET_GEMINI_BASE_URL || undefined);
};
