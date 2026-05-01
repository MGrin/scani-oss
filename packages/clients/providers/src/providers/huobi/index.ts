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
import { splitConcatenatedPair } from '../../core/utils/symbol-splitter';
import { huobiManifest } from './manifest';

export { huobiManifest } from './manifest';

const HUOBI_INSTITUTION_CODE = 'huobi';
const HUOBI_HOST = 'api.huobi.pro';

const QUOTE_POOL = ['usdt', 'usdc', 'husd', 'btc', 'usd'] as const;
const HUOBI_QUOTE_ASSETS = ['USDT', 'USDC', 'HUSD', 'USD', 'BTC', 'ETH'] as const;
const MAX_CANDIDATE_SYMBOLS = 30;
const MATCHRESULTS_PAGE_SIZE = 500;
const DEPOSIT_WITHDRAW_PAGE_SIZE = 500;
const MAX_PAGES = 200;

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

    const merged = await this.fetchAggregateSpotBalances(creds);
    const out: HoldingSnapshot[] = [];
    for (const [currency, total] of merged) {
      out.push({
        externalId: currency,
        tokenIdentity: tokenIdentity(currency),
        balance: total.toString(),
        capturedAt: new Date(),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === HUOBI_INSTITUTION_CODE;
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

    const balances = await this.fetchAggregateSpotBalances(creds);
    const currencies = [...balances.keys()].map((c) => c.toLowerCase());
    if (currencies.length === 0) return [];

    const sinceMs = ctx.since?.getTime();
    const untilMs = ctx.until?.getTime();

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    const push = (event: TransactionEvent | null): void => {
      if (!event) return;
      if (seen.has(event.externalId)) return;
      seen.add(event.externalId);
      events.push(event);
    };

    for (const symbol of buildCandidateSymbols(currencies, MAX_CANDIDATE_SYMBOLS)) {
      for await (const row of this.iterateMatchResults(creds, symbol, sinceMs, untilMs)) {
        push(matchResultToEvent(row));
      }
    }

    for (const currency of currencies) {
      for await (const row of this.iterateDepositWithdraw(
        creds,
        currency,
        'deposit',
        sinceMs,
        untilMs
      )) {
        push(depositWithdrawToEvent(row));
      }
      for await (const row of this.iterateDepositWithdraw(
        creds,
        currency,
        'withdraw',
        sinceMs,
        untilMs
      )) {
        push(depositWithdrawToEvent(row));
      }
    }

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
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchAggregateSpotBalances(creds: ApiKeyCreds): Promise<Map<string, Decimal>> {
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
        if (balanceData.status !== 'ok') continue;
        for (const b of balanceData.data.list) {
          const amt = new Decimal(b.balance || '0');
          if (amt.lte(0)) continue;
          merged.set(b.currency, (merged.get(b.currency) ?? new Decimal(0)).plus(amt));
        }
      } catch {
        // Per-account failures shouldn't kill the whole sync; skip.
      }
    }
    return merged;
  }

  private async *iterateMatchResults(
    creds: ApiKeyCreds,
    symbol: string,
    sinceMs: number | undefined,
    untilMs: number | undefined
  ): AsyncGenerator<HuobiMatchResult> {
    const path = '/v1/order/matchresults';
    let fromId: string | undefined;
    let pages = 0;
    while (pages < MAX_PAGES) {
      pages += 1;
      const extra: Record<string, string> = {
        symbol,
        size: String(MATCHRESULTS_PAGE_SIZE),
        direct: 'next',
      };
      if (sinceMs !== undefined) extra['start-time'] = String(sinceMs);
      if (untilMs !== undefined) extra['end-time'] = String(untilMs);
      if (fromId !== undefined) extra['from-id'] = fromId;

      const data = await this.signedJson<HuobiMatchResultsResponse>(
        { method: 'GET', url: path, query: this.authQueryString(creds, 'GET', path, extra) },
        creds
      );
      if (data.status !== 'ok') {
        // Invalid symbol or temporary glitch: skip this symbol entirely
        // rather than abort the whole transactions sync.
        return;
      }
      const rows = data.data ?? [];
      for (const row of rows) yield row;
      if (rows.length < MATCHRESULTS_PAGE_SIZE) return;
      const last = rows[rows.length - 1];
      if (!last) return;
      fromId = String(last.id);
    }
  }

  private async *iterateDepositWithdraw(
    creds: ApiKeyCreds,
    currency: string,
    type: 'deposit' | 'withdraw',
    sinceMs: number | undefined,
    untilMs: number | undefined
  ): AsyncGenerator<HuobiDepositWithdrawRow> {
    const path = '/v1/query/deposit-withdraw';
    let from: string | undefined;
    let pages = 0;
    while (pages < MAX_PAGES) {
      pages += 1;
      const extra: Record<string, string> = {
        currency,
        type,
        size: String(DEPOSIT_WITHDRAW_PAGE_SIZE),
        direct: 'next',
      };
      if (from !== undefined) extra.from = from;

      const data = await this.signedJson<HuobiDepositWithdrawResponse>(
        { method: 'GET', url: path, query: this.authQueryString(creds, 'GET', path, extra) },
        creds
      );
      if (data.status !== 'ok') return;
      const rows = data.data ?? [];
      let lastId: number | undefined;
      for (const row of rows) {
        lastId = row.id;
        const ts = (row['updated-at'] ?? row['created-at']) || 0;
        if (sinceMs !== undefined && ts < sinceMs) continue;
        if (untilMs !== undefined && ts > untilMs) continue;
        yield row;
      }
      if (rows.length < DEPOSIT_WITHDRAW_PAGE_SIZE) return;
      if (lastId === undefined) return;
      from = String(lastId);
    }
  }
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

export function matchResultToEvent(row: HuobiMatchResult): TransactionEvent | null {
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

export function depositWithdrawToEvent(row: HuobiDepositWithdrawRow): TransactionEvent {
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
