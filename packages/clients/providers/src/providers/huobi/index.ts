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
import { splitConcatenatedPair } from '../../core/utils/symbol-splitter';
import type { TimeWindow } from '../../core/utils/time-windows';
import { WalkFailureWatch } from '../../core/utils/walk-failures';
import { huobiManifest } from './manifest';

const HUOBI_INSTITUTION_CODE = 'huobi';
const HUOBI_HOST = 'api.huobi.pro';

const QUOTE_POOL = ['usdt', 'usdc', 'husd', 'btc', 'usd'] as const;
const HUOBI_QUOTE_ASSETS = ['USDT', 'USDC', 'HUSD', 'USD', 'BTC', 'ETH'] as const;
const MAX_CANDIDATE_SYMBOLS = 30;
const MATCHRESULTS_PAGE_SIZE = 500;
const DEPOSIT_WITHDRAW_PAGE_SIZE = 500;
const MAX_PAGES = 200;
const HOUR_MS = 60 * 60 * 1000;
// `/v1/order/matchresults` answers [end-time − 48h, end-time] when given no
// start-time, and "the query window can be shifted within 120 days" —
// https://huobiapi.github.io/docs/spot/v1/en/. So fills are walked in 48h
// windows, and nothing older than 120 days is reachable at all.
const MATCHRESULTS_WINDOW_MS = 48 * HOUR_MS;
const MATCHRESULTS_REACH_MS = 120 * 24 * HOUR_MS;
// The oldest window is requested last, possibly minutes into a long run, so
// the walk stops an hour short of the limit rather than be refused at its edge.
const MATCHRESULTS_WALK_REACH_MS = MATCHRESULTS_REACH_MS - HOUR_MS;

interface HuobiBalance {
  currency: string;
  type: string;
  balance: string;
}

interface HuobiAccountsResponse {
  status: string;
  data: Array<{ id: number; type: string; state: string }>;
}

interface HuobiBalanceResponse {
  status: string;
  data: { id: number; type: string; state: string; list: HuobiBalance[] };
}

interface HuobiMatchResult {
  id: number;
  symbol: string;
  type: string;
  price: string;
  'filled-amount': string;
  'filled-fees': string;
  'fee-currency': string;
  'created-at': number;
  'match-id': number;
  'order-id': number;
  'trade-id': number;
}

interface HuobiMatchResultsResponse {
  status: string;
  'err-code'?: string;
  'err-msg'?: string;
  data?: HuobiMatchResult[];
}

interface HuobiDepositWithdrawRow {
  id: number;
  type: 'deposit' | 'withdraw';
  'sub-type'?: string;
  currency: string;
  'tx-hash'?: string;
  chain?: string;
  amount: string;
  address?: string;
  fee?: string;
  state: string;
  'created-at': number;
  'updated-at'?: number;
}

interface HuobiDepositWithdrawResponse {
  status: string;
  'err-code'?: string;
  'err-msg'?: string;
  data?: HuobiDepositWithdrawRow[];
}

function tokenIdentity(currency: string): Partial<NewToken> {
  return {
    symbol: currency.toUpperCase(),
    name: currency,
    providerMetadata: { huobi: { currency } },
  };
}

export class HuobiProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'huobi';
  readonly manifest = huobiManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  // Declared so the router never claims a complete history here. Trades are
  // asked for per symbol, and the symbols are enumerated from balances and
  // deposit/withdraw history, so an asset bought and sold to zero without
  // ever moving on or off the exchange is never seen; and `matchresults`
  // reaches back no further than 120 days, whatever the walk asks.
  readonly transactionHistoryHorizonMs = MATCHRESULTS_WALK_REACH_MS;
  protected readonly baseUrl = `https://${HUOBI_HOST}`;

  // Huobi puts the signature in the query string; signRequest contributes
  // no headers. Subclass builds the signed query via authQueryString.
  protected signRequest(_req: SignedRequest, _creds: ApiKeyCreds): Record<string, string> {
    return {};
  }

  private authQueryString(
    creds: ApiKeyCreds,
    method: string,
    path: string,
    extra?: Record<string, string>
  ): string {
    const params: Record<string, string> = {
      ...(extra ?? {}),
      AccessKeyId: creds.apiKey,
      SignatureMethod: 'HmacSHA256',
      SignatureVersion: '2',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    };
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(params[k]!)}`)
      .join('&');
    const payload = `${method}\n${HUOBI_HOST}\n${path}\n${sortedParams}`;
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(payload).digest('base64');
    return `${sortedParams}&Signature=${encodeURIComponent(signature)}`;
  }

  canFetchBalances(c: string): boolean {
    return c === HUOBI_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    // A balances run has no retraction channel, so an unreadable account is
    // at least said out loud rather than read as an account holding nothing.
    const merged = await this.fetchAggregateSpotBalances(creds, (accountId, err) =>
      this.logger.warn(
        {
          providerKey: this.providerKey,
          accountId,
          err: err instanceof Error ? err.message : err,
        },
        'Huobi spot account balance could not be read; its holdings are missing from this sync'
      )
    );
    const out: HoldingSnapshot[] = [];
    for (const [currency, total] of merged) {
      out.push({
        externalId: currency,
        tokenIdentity: tokenIdentity(currency),
        balance: total.toString(),
        capturedAt: new Date(),
        tokenType: tokenTypeForCexAsset(currency),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === HUOBI_INSTITUTION_CODE;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const capped = new PageCapWatch();
    const failures = new WalkFailureWatch(this.providerKey, this.logger);

    const balances = await this.fetchAggregateSpotBalances(creds, (accountId, err) =>
      failures.note(`the balance read for account ${accountId}`, err)
    );

    const sinceMs = ctx.since?.getTime();
    const untilMs = ctx.until?.getTime();

    // Deposits and withdrawals are walked across every currency, not per
    // held one: they are the only feed Huobi lists without a symbol, so they
    // are what names an asset that has since been sold to zero (SC-1480).
    const transfers: HuobiDepositWithdrawRow[] = [];
    for (const type of ['deposit', 'withdraw'] as const) {
      for await (const row of this.iterateDepositWithdraw(
        creds,
        type,
        sinceMs,
        untilMs,
        capped,
        failures
      )) {
        transfers.push(row);
      }
    }

    const currencies = new Set([...balances.keys()].map((c) => c.toLowerCase()));
    for (const row of transfers) {
      if (row.currency) currencies.add(row.currency.toLowerCase());
    }

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    const push = (event: TransactionEvent | null): void => {
      if (!event) return;
      if (seen.has(event.externalId)) return;
      seen.add(event.externalId);
      events.push(event);
    };

    const symbols = buildCandidateSymbols([...currencies], MAX_CANDIDATE_SYMBOLS);
    const unwalked = countCandidateSymbols([...currencies]) - symbols.length;
    if (unwalked > 0) {
      const reason = `huobi: ${unwalked} candidate trading pair${unwalked === 1 ? '' : 's'} beyond the ${MAX_CANDIDATE_SYMBOLS}-pair cap ${unwalked === 1 ? 'was' : 'were'} never walked, so their trades were never fetched`;
      this.logger.warn({ providerKey: this.providerKey, unwalked }, reason);
      ctx.retractHistoryClaim?.(reason);
    }
    const now = Date.now();
    const reachFloor = now - MATCHRESULTS_WALK_REACH_MS;
    if (ctx.since && ctx.since.getTime() < reachFloor) {
      const reason = `huobi: fills before ${new Date(reachFloor).toISOString().slice(0, 10)} are beyond the 120 days /v1/order/matchresults serves, so trades older than that were never fetched`;
      this.logger.warn({ providerKey: this.providerKey }, reason);
      ctx.retractHistoryClaim?.(reason);
    }
    const windows = matchResultWindows(Math.max(sinceMs ?? reachFloor, reachFloor), untilMs ?? now);
    for (const symbol of symbols) {
      for await (const row of this.iterateMatchResults(creds, symbol, windows, capped, failures)) {
        push(matchResultToEvent(row));
      }
    }

    for (const row of transfers) push(depositWithdrawToEvent(row));

    capped.retract(ctx, this.providerKey);
    failures.retract(ctx);
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== HUOBI_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };
    try {
      const data = await this.signedJson<{ status: string }>(
        {
          method: 'GET',
          url: '/v1/account/accounts',
          query: this.authQueryString({ apiKey, apiSecret }, 'GET', '/v1/account/accounts'),
        },
        { apiKey, apiSecret }
      );
      if (data.status !== 'ok') return { valid: false, message: `Huobi: ${data.status}` };
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  /**
   * A spot account whose balance cannot be read is skipped rather than
   * failing the whole read, and reported through `onAccountFailure`.
   */
  private async fetchAggregateSpotBalances(
    creds: ApiKeyCreds,
    onAccountFailure: (accountId: number, err?: unknown) => void
  ): Promise<Map<string, Decimal>> {
    const accountsData = await this.signedJson<HuobiAccountsResponse>(
      {
        method: 'GET',
        url: '/v1/account/accounts',
        query: this.authQueryString(creds, 'GET', '/v1/account/accounts'),
      },
      creds
    );
    if (accountsData.status !== 'ok') {
      throw new ProviderError(`Huobi: ${accountsData.status}`, 'unrecoverable', this.providerKey);
    }
    const spotAccounts = accountsData.data.filter(
      (a) => a.type === 'spot' && a.state === 'working'
    );

    const merged = new Map<string, Decimal>();
    for (const acct of spotAccounts) {
      const path = `/v1/account/accounts/${acct.id}/balance`;
      try {
        const balanceData = await this.signedJson<HuobiBalanceResponse>(
          { method: 'GET', url: path, query: this.authQueryString(creds, 'GET', path) },
          creds
        );
        if (balanceData.status !== 'ok') {
          onAccountFailure(acct.id, balanceData.status);
          continue;
        }
        for (const b of balanceData.data.list) {
          const amt = new Decimal(b.balance || '0');
          if (amt.lte(0)) continue;
          merged.set(b.currency, (merged.get(b.currency) ?? new Decimal(0)).plus(amt));
        }
      } catch (err) {
        onAccountFailure(acct.id, err);
      }
    }
    return merged;
  }

  private async *iterateMatchResults(
    creds: ApiKeyCreds,
    symbol: string,
    windows: readonly TimeWindow[],
    capped: PageCapWatch,
    failures: WalkFailureWatch
  ): AsyncGenerator<HuobiMatchResult> {
    const path = '/v1/order/matchresults';
    // One page budget per symbol across all of its windows.
    let pages = 0;
    let rows = 0;
    for (const window of windows) {
      let fromId: string | undefined;
      while (true) {
        if (pages >= MAX_PAGES) {
          capped.note({ walk: { kind: 'symbolTrades', symbol }, pages: MAX_PAGES, rows });
          return;
        }
        pages += 1;
        const extra: Record<string, string> = {
          symbol,
          size: String(MATCHRESULTS_PAGE_SIZE),
          direct: 'next',
          'start-time': String(window.start.getTime()),
          'end-time': String(window.end.getTime()),
        };
        if (fromId !== undefined) extra['from-id'] = fromId;

        const data = await this.signedJson<HuobiMatchResultsResponse>(
          { method: 'GET', url: path, query: this.authQueryString(creds, 'GET', path, extra) },
          creds
        );
        if (data.status !== 'ok') {
          // A candidate pair Huobi does not list is an absent market. Anything
          // else is a walk that stopped short, and says so.
          if (!isInvalidSymbol(data)) {
            failures.note(`the ${symbol} trades walk`, data['err-code'] ?? data.status);
          }
          return;
        }
        const page = data.data ?? [];
        rows += page.length;
        for (const row of page) yield row;
        if (page.length < MATCHRESULTS_PAGE_SIZE) break;
        const last = page[page.length - 1];
        if (!last) break;
        fromId = String(last.id);
      }
    }
  }

  private async *iterateDepositWithdraw(
    creds: ApiKeyCreds,
    type: 'deposit' | 'withdraw',
    sinceMs: number | undefined,
    untilMs: number | undefined,
    capped: PageCapWatch,
    failures: WalkFailureWatch
  ): AsyncGenerator<HuobiDepositWithdrawRow> {
    const path = '/v1/query/deposit-withdraw';
    let from: string | undefined;
    let pages = 0;
    let rows = 0;
    while (pages < MAX_PAGES) {
      pages += 1;
      const extra: Record<string, string> = {
        type,
        size: String(DEPOSIT_WITHDRAW_PAGE_SIZE),
        direct: 'next',
      };
      if (from !== undefined) extra.from = from;

      const data = await this.signedJson<HuobiDepositWithdrawResponse>(
        { method: 'GET', url: path, query: this.authQueryString(creds, 'GET', path, extra) },
        creds
      );
      if (data.status !== 'ok') {
        failures.note(`the ${type} walk`, data['err-code'] ?? data.status);
        return;
      }
      const page = data.data ?? [];
      rows += page.length;
      let lastId: number | undefined;
      for (const row of page) {
        lastId = row.id;
        const ts = (row['updated-at'] ?? row['created-at']) || 0;
        if (sinceMs !== undefined && ts < sinceMs) continue;
        if (untilMs !== undefined && ts > untilMs) continue;
        yield row;
      }
      if (page.length < DEPOSIT_WITHDRAW_PAGE_SIZE) return;
      if (lastId === undefined) return;
      from = String(lastId);
    }
    capped.note({
      walk: { kind: 'feed', path: `/v1/query/deposit-withdraw?type=${type}` },
      pages: MAX_PAGES,
      rows,
    });
  }
}

// "base-symbol-error symbol is invalid" — https://huobiapi.github.io/docs/spot/v1/en/
function isInvalidSymbol(data: HuobiMatchResultsResponse): boolean {
  return data['err-code'] === 'base-symbol-error';
}

/** How many candidates `buildCandidateSymbols` would return with no cap. */
function countCandidateSymbols(currencies: string[]): number {
  return buildCandidateSymbols(currencies, Number.POSITIVE_INFINITY).length;
}

/** 48h windows walked backwards from `untilMs` to `floorMs`, newest first. */
function matchResultWindows(floorMs: number, untilMs: number): TimeWindow[] {
  const out: TimeWindow[] = [];
  let end = untilMs;
  while (end > floorMs) {
    const start = Math.max(end - MATCHRESULTS_WINDOW_MS, floorMs);
    out.push({ start: new Date(start), end: new Date(end) });
    end = start;
  }
  return out;
}

export function buildCandidateSymbols(
  currencies: string[],
  cap: number = MAX_CANDIDATE_SYMBOLS
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Stablecoin quotes first so the cap doesn't push them out in favor of
  // BTC pairs when the user holds many altcoins.
  for (const quote of QUOTE_POOL) {
    for (const base of currencies) {
      if (out.length >= cap) return out;
      if (base === quote) continue;
      const symbol = `${base}${quote}`;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      out.push(symbol);
    }
  }
  return out;
}

function matchResultToEvent(row: HuobiMatchResult): TransactionEvent | null {
  const split = splitConcatenatedPair(row.symbol, HUOBI_QUOTE_ASSETS);
  if (!split) return null;
  const side: TransactionEvent['kind'] = row.type.startsWith('buy-')
    ? 'buy'
    : row.type.startsWith('sell-')
      ? 'sell'
      : 'unknown';
  if (side !== 'buy' && side !== 'sell') return null;

  const baseQty = enforceSign(row['filled-amount'], side);
  const quoteAbs = new Decimal(row['filled-amount'] || '0').times(row.price || '0').toString();
  const counterQty = inferCounterSign(baseQty, quoteAbs);

  let fee: TransactionEvent['fee'];
  const feeCurrency = row['fee-currency'] || split.quote.toLowerCase();
  if (row['filled-fees'] && !new Decimal(row['filled-fees']).isZero()) {
    fee = {
      tokenIdentity: tokenIdentity(feeCurrency),
      quantity: negateFee(row['filled-fees']),
    };
  }

  return {
    externalId: `match:${row.id}`,
    occurredAt: new Date(row['created-at']),
    kind: side,
    primary: { tokenIdentity: tokenIdentity(split.base.toLowerCase()), quantity: baseQty },
    counter: { tokenIdentity: tokenIdentity(split.quote.toLowerCase()), quantity: counterQty },
    fee,
    rawPayload: row,
  };
}

function depositWithdrawToEvent(row: HuobiDepositWithdrawRow): TransactionEvent {
  const ts = row['updated-at'] ?? row['created-at'] ?? 0;
  const occurredAt = new Date(ts);
  const kind: TransactionEvent['kind'] = row.type === 'deposit' ? 'deposit' : 'withdraw';
  const idSeed =
    row['tx-hash'] && row['tx-hash'].length > 0 ? row['tx-hash'] : `${row.type}-${row.id}`;
  const externalId = `${row.type}:${idSeed}`;

  let fee: TransactionEvent['fee'];
  if (row.fee && !new Decimal(row.fee).isZero()) {
    fee = {
      tokenIdentity: tokenIdentity(row.currency),
      quantity: negateFee(row.fee),
    };
  }

  return {
    externalId,
    occurredAt,
    kind,
    primary: {
      tokenIdentity: tokenIdentity(row.currency),
      quantity: enforceSign(row.amount, kind),
    },
    fee,
    rawPayload: row,
  };
}

export const huobiFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'huobi-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'huobi-private',
    limiter,
    registeredFrom: 'providers/huobi',
    description: 'Huobi: 10 req / 1s per API key',
  });
  return new HuobiProvider(registered);
};
