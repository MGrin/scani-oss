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
import { tokenTypeForCexAsset } from '../../core/utils/fiat-codes';
import { PageCapWatch } from '../../core/utils/page-cap';
import { mapKucoinBizType } from './biz-types';
import { kucoinManifest } from './manifest';

const KUCOIN_INSTITUTION_CODE = 'kucoin';

const PAGE_SIZE = 500;
const MAX_PAGES = 400;

interface KucoinAccount {
  currency: string;
  type: string;
  balance: string;
  available: string;
}

interface KucoinPagedResponse<T> {
  code: string;
  msg?: string;
  data?: {
    currentPage: number;
    pageSize: number;
    totalNum: number;
    totalPage: number;
    items: T[];
  };
}

interface KucoinLedgerItem {
  id: string;
  currency: string;
  amount: string;
  fee: string;
  balance: string;
  accountType?: string;
  bizType: string;
  direction: 'in' | 'out';
  createdAt: number;
  context?: string;
}

/** A row of `/api/v1/deposits` or `/api/v1/withdrawals`. */
interface KucoinTransferRecord {
  currency: string;
  chain?: string;
  status: string;
  isInner?: boolean;
  amount: string;
  fee?: string;
  walletTxId?: string;
  createdAt: number;
}

// The ledger row and its record are written moments apart; a minute is wide
// for that and narrow for two transfers of one currency and amount.
const RECORD_JOIN_WINDOW_MS = 60_000;

// A row KuCoin sends without a type is no transfer of either side.
const transferSide = (item: KucoinLedgerItem): 'deposit' | 'withdraw' | null => {
  if (typeof item.bizType !== 'string') return null;
  const kind = mapKucoinBizType(item.bizType, item.direction === 'in');
  return kind === 'deposit' || kind === 'withdraw' ? kind : null;
};

/**
 * The chain txid of each deposit or withdrawal ledger row, keyed by ledger id
 * (SC-1584). The ledger carries none and its `context` is undocumented, so the
 * join is by currency, side, time and amount, the amount with the record's fee
 * either inside it or on top of it. Anything but one ledger row to one record
 * leaves the row without a txid: a wrong txid would pair it with another
 * holding's transaction, and no txid only loses a link.
 */
function joinTransferTxids(
  ledger: readonly KucoinLedgerItem[],
  deposits: readonly KucoinTransferRecord[],
  withdrawals: readonly KucoinTransferRecord[]
): Map<string, { hash: string; chain: string | null }> {
  const usable = (r: KucoinTransferRecord) =>
    r.status === 'SUCCESS' && !r.isInner && (r.walletTxId ?? '').split('@')[0] !== '';
  const candidates = (item: KucoinLedgerItem): KucoinTransferRecord[] => {
    const side = transferSide(item);
    const pool = side === 'deposit' ? deposits : side === 'withdraw' ? withdrawals : [];
    const amount = new Decimal(item.amount || '0').abs();
    return pool.filter((r) => {
      if (!usable(r) || r.currency !== item.currency) return false;
      if (Math.abs(r.createdAt - item.createdAt) > RECORD_JOIN_WINDOW_MS) return false;
      const base = new Decimal(r.amount || '0');
      const fee = new Decimal(r.fee || '0');
      return amount.eq(base) || amount.eq(base.plus(fee)) || amount.eq(base.minus(fee));
    });
  };

  // One-to-one both ways: a record that fits any second row, even one with
  // several candidates of its own, is ambiguous and goes to nobody.
  const lists = ledger.map((item) => ({ item, found: candidates(item) }));
  const claims = new Map<KucoinTransferRecord, number>();
  for (const { found } of lists) for (const r of found) claims.set(r, (claims.get(r) ?? 0) + 1);

  const txids = new Map<string, { hash: string; chain: string | null }>();
  for (const { item, found } of lists) {
    if (found.length !== 1) continue;
    const only = found[0]!;
    if (claims.get(only) !== 1) continue;
    txids.set(item.id, { hash: (only.walletTxId ?? '').split('@')[0]!, chain: only.chain ?? null });
  }
  return txids;
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return {
    symbol,
    name: symbol,
    providerMetadata: { kucoin: { currency: currency } },
  };
}

export function ledgerItemToEvent(
  item: KucoinLedgerItem,
  txid?: { hash: string; chain: string | null }
): TransactionEvent | null {
  // KuCoin sends `amount` unsigned; the side lives only in `direction` (SC-1479).
  // An absent or unrecognised `direction` falls back to the amount's own sign
  // rather than defaulting to an outflow, which would be this defect inverted.
  const raw = new Decimal(item.amount || '0');
  const magnitude = raw.abs();
  if (magnitude.isZero()) return null;
  const isInflow =
    item.direction === 'in' ? true : item.direction === 'out' ? false : raw.isPositive();
  const quantity = isInflow ? magnitude : magnitude.neg();
  const kind = mapKucoinBizType(item.bizType, isInflow);

  const event: TransactionEvent = {
    externalId: `ledger:${item.id}`,
    occurredAt: new Date(item.createdAt),
    kind,
    primary: { tokenIdentity: tokenIdentity(item.currency), quantity: quantity.toString() },
    rawPayload: txid ? { ...item, hash: txid.hash, chain: txid.chain } : item,
  };

  const fee = new Decimal(item.fee || '0');
  if (fee.gt(0)) {
    event.fee = {
      tokenIdentity: tokenIdentity(item.currency),
      quantity: fee.neg().toString(),
    };
  }

  return event;
}

export class KucoinProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'kucoin';
  readonly manifest = kucoinManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = 'https://api.kucoin.com';

  // KuCoin V2: passphrase itself is HMAC-signed before being sent over
  // the wire (protects against passphrase leak via header logs).
  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = Date.now().toString();
    const queryStr = req.query ? `?${req.query}` : '';
    const preSign = timestamp + req.method + req.url + queryStr + (req.body ?? '');
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(preSign).digest('base64');
    const signedPassphrase = crypto
      .createHmac('sha256', creds.apiSecret)
      .update(creds.passphrase ?? '')
      .digest('base64');
    return {
      'KC-API-KEY': creds.apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': signedPassphrase,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json',
    };
  }

  canFetchBalances(c: string): boolean {
    return c === KUCOIN_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds?.passphrase) return [];

    const data = await this.signedJson<{ code: string; msg?: string; data?: KucoinAccount[] }>(
      { method: 'GET', url: '/api/v1/accounts' },
      creds
    );
    if (data.code !== '200000') {
      throw new ProviderError(
        `KuCoin code=${data.code}: ${data.msg ?? ''}`,
        'unrecoverable',
        this.providerKey
      );
    }

    // Sum across account types (main + trade + margin) per currency.
    const merged = new Map<string, Decimal>();
    for (const a of data.data ?? []) {
      const amt = new Decimal(a.balance || '0');
      if (amt.lte(0)) continue;
      merged.set(a.currency, (merged.get(a.currency) ?? new Decimal(0)).plus(amt));
    }

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

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === KUCOIN_INSTITUTION_CODE;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds?.passphrase) return [];

    const capped = new PageCapWatch();

    const startAt = ctx.since?.getTime();
    const endAt = ctx.until?.getTime();

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    const push = (event: TransactionEvent | null): void => {
      if (!event) return;
      if (seen.has(event.externalId)) return;
      seen.add(event.externalId);
      events.push(event);
    };

    // Deposits and withdrawals are the ledger's rows too: its `amount` is the
    // balance change with any fee included, which a withdrawal record cannot
    // give, since KuCoin takes the fee from the amount or on top of it and the
    // record does not say which. `/api/v1/hist-deposits` and `hist-withdrawals`
    // are deprecated and hold only pre-2019-02-18 records (SC-1575).
    const ledger: KucoinLedgerItem[] = [];
    for await (const item of this.paginate<KucoinLedgerItem>(
      '/api/v1/accounts/ledgers',
      creds,
      startAt,
      endAt,
      capped
    )) {
      ledger.push(item);
    }
    const annotationCap = new PageCapWatch();
    const txids = await this.transferTxids(ledger, creds, startAt, endAt, annotationCap, ctx);
    for (const item of ledger) push(ledgerItemToEvent(item, txids.get(item.id)));

    capped.retract(ctx, this.providerKey);
    // A warning, never a retraction: the record walks annotate rows the ledger
    // walk already produced, so a short one costs txids and not rows (SC-428).
    annotationCap.warn(ctx, this.providerKey, 'missingTxIds');
    return events;
  }

  // The txid is enrichment: the ledger alone is the balance, so a record
  // lookup that fails keeps every row and says so rather than failing the sync.
  private async transferTxids(
    ledger: readonly KucoinLedgerItem[],
    creds: ApiKeyCreds,
    startAt: number | undefined,
    endAt: number | undefined,
    capped: PageCapWatch,
    ctx: TransactionFetchContext
  ): Promise<Map<string, { hash: string; chain: string | null }>> {
    if (!ledger.some((item) => transferSide(item) !== null)) return new Map();
    try {
      const deposits: KucoinTransferRecord[] = [];
      for await (const r of this.paginate<KucoinTransferRecord>(
        '/api/v1/deposits',
        creds,
        startAt,
        endAt,
        capped
      ))
        deposits.push(r);
      const withdrawals: KucoinTransferRecord[] = [];
      for await (const r of this.paginate<KucoinTransferRecord>(
        '/api/v1/withdrawals',
        creds,
        startAt,
        endAt,
        capped
      ))
        withdrawals.push(r);
      return joinTransferTxids(ledger, deposits, withdrawals);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.noteWarning?.({
        key: 'v3.jobs.notices.txIdLookupFailed',
        params: { provider: this.providerKey, reason },
        text: `${this.providerKey}: deposit and withdrawal records could not be read, so this run's deposits and withdrawals carry no on-chain transaction id (${reason})`,
      });
      return new Map();
    }
  }

  private async *paginate<T>(
    path: string,
    creds: ApiKeyCreds,
    startAt: number | undefined,
    endAt: number | undefined,
    capped: PageCapWatch
  ): AsyncGenerator<T> {
    let currentPage = 1;
    let rows = 0;
    let truncated = false;
    while (currentPage <= MAX_PAGES) {
      const params = new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        currentPage: String(currentPage),
      });
      if (startAt !== undefined) params.set('startAt', String(startAt));
      if (endAt !== undefined) params.set('endAt', String(endAt));

      const data = await this.signedJson<KucoinPagedResponse<T>>(
        { method: 'GET', url: path, query: params.toString() },
        creds
      );
      if (data.code !== '200000') {
        throw new ProviderError(
          `KuCoin ${path} code=${data.code}: ${data.msg ?? ''}`,
          'unrecoverable',
          this.providerKey
        );
      }

      const items = data.data?.items ?? [];
      rows += items.length;
      for (const item of items) yield item;

      const totalPage = data.data?.totalPage ?? 0;
      if (currentPage >= totalPage) break;
      if (items.length < PAGE_SIZE) break;
      // KuCoin says how many pages exist, so the cap is reached with the
      // remainder known: the next iteration would exceed MAX_PAGES.
      if (currentPage === MAX_PAGES) truncated = true;
      currentPage += 1;
    }
    if (truncated) capped.note({ walk: { kind: 'feed', path }, pages: MAX_PAGES, rows });
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== KUCOIN_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    const passphrase = creds.passphrase as string | undefined;
    if (!apiKey || !apiSecret || !passphrase) {
      return { valid: false, message: 'apiKey + apiSecret + passphrase required' };
    }
    try {
      const data = await this.signedJson<{ code: string; msg?: string }>(
        { method: 'GET', url: '/api/v1/accounts' },
        { apiKey, apiSecret, passphrase }
      );
      if (data.code !== '200000') {
        return { valid: false, message: `KuCoin code=${data.code}: ${data.msg ?? ''}` };
      }
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }
}

export const kucoinFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'kucoin-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'kucoin-private',
    limiter,
    registeredFrom: 'providers/kucoin',
    description: 'KuCoin V2: 10 req / 1s per API key',
  });
  return new KucoinProvider(registered);
};
