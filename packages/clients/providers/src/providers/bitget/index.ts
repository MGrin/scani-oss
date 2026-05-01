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
import { bitgetManifest } from './manifest';

export { bitgetManifest } from './manifest';

const BITGET_INSTITUTION_CODE = 'bitget';

// Bitget V2 spot/trade/fills + wallet/deposit-records + wallet/withdrawal-
// records all paginate via `idLessThan`: pass the smallest record id from
// the previous page to fetch older rows. Page size cap is 500; we use 100
// for snappier round-trips. MAX_PAGES caps a single import at 5k rows so a
// runaway cursor can't burn the rate-limiter budget.
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

interface BitgetAsset {
  coin: string;
  available: string;
  frozen: string;
  locked: string;
}

interface BitgetEnvelope<T> {
  code: string;
  msg: string;
  data: T;
}

interface BitgetFeeDetail {
  deduction?: string;
  feeCoin?: string;
  totalDeductionFee?: string;
  totalFee?: string;
}

interface BitgetFill {
  symbol: string;
  orderId: string;
  tradeId: string;
  side: string;
  priceAvg?: string;
  price?: string;
  /** V2 spot fills uses `size` for base volume, `amount` for quote. */
  size?: string;
  amount?: string;
  baseVolume?: string;
  quoteVolume?: string;
  feeDetail?: BitgetFeeDetail;
  cTime: string;
  uTime?: string;
}

interface BitgetDepositRow {
  orderId: string;
  /** On-chain tx hash on Bitget V2 surfaces under `tradeId`. */
  tradeId?: string;
  coin: string;
  size: string;
  status?: string;
  toAddress?: string;
  fromAddress?: string;
  chain?: string;
  dest?: string;
  cTime: string;
  uTime?: string;
}

interface BitgetWithdrawalRow {
  orderId: string;
  tradeId?: string;
  coin: string;
  size: string;
  fee?: string;
  chain?: string;
  toAddress?: string;
  status?: string;
  cTime: string;
  uTime?: string;
}

export class BitgetProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'bitget';
  readonly manifest = bitgetManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = 'https://api.bitget.com';

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = Date.now().toString();
    // Bitget V2 pre-sign: timestamp + method + requestPath + ?queryString +
    // body. The leading `?` is part of the canonical form when a query is
    // present — drop it (or the whole segment) when there is no query.
    // Sibling impls: OKX uses the identical layout; Bybit folds query into
    // the pre-sign without the `?` prefix.
    const queryStr = req.query ? `?${req.query}` : '';
    const preSign = timestamp + req.method + req.url + queryStr + (req.body ?? '');
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(preSign).digest('base64');
    return {
      'ACCESS-KEY': creds.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': creds.passphrase ?? '',
      'Content-Type': 'application/json',
    };
  }

  canFetchBalances(c: string): boolean {
    return c === BITGET_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds?.passphrase) return [];

    const data = await this.signedJson<BitgetEnvelope<BitgetAsset[]>>(
      { method: 'GET', url: '/api/v2/spot/account/assets' },
      creds
    );
    if (data.code !== '00000') {
      throw new ProviderError(
        `Bitget code=${data.code}: ${data.msg}`,
        'unrecoverable',
        this.providerKey
      );
    }

    const out: HoldingSnapshot[] = [];
    for (const a of data.data ?? []) {
      const total = new Decimal(a.available || '0').plus(a.frozen || '0').plus(a.locked || '0');
      if (total.lte(0)) continue;
      out.push({
        externalId: a.coin,
        tokenIdentity: this.coinIdentity(a.coin),
        balance: total.toString(),
        capturedAt: new Date(),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === BITGET_INSTITUTION_CODE;
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

    const until = ctx.until ?? new Date();
    const since = ctx.since ?? new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);

    // We fan out to three Bitget V2 feeds rather than the unified
    // transactionRecords bills feed. Bills emit one row per coin leg, so a
    // single trade splits into a base-coin row and a quote-coin row that we
    // would have to re-pair by orderId. /trade/fills already returns both
    // legs + fee detail in one row, and the dedicated deposit/withdrawal
    // endpoints carry the on-chain txId we need for transfer linking.
    const events: TransactionEvent[] = [];
    for await (const fill of this.iterateFills(creds, since, until)) {
      const ev = this.mapFill(fill);
      if (ev) events.push(ev);
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
    if (institutionCode !== BITGET_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    const passphrase = creds.passphrase as string | undefined;
    if (!apiKey || !apiSecret || !passphrase) {
      return { valid: false, message: 'apiKey + apiSecret + passphrase required' };
    }
    try {
      const data = await this.signedJson<BitgetEnvelope<unknown>>(
        { method: 'GET', url: '/api/v2/spot/account/assets' },
        { apiKey, apiSecret, passphrase }
      );
      if (data.code !== '00000') {
        return { valid: false, message: `Bitget code=${data.code}: ${data.msg}` };
      }
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async *iterateFills(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BitgetFill> {
    let idLessThan: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        startTime: since.getTime().toString(),
        endTime: until.getTime().toString(),
        limit: PAGE_LIMIT.toString(),
      });
      if (idLessThan) params.set('idLessThan', idLessThan);
      const data = await this.signedJson<BitgetEnvelope<BitgetFill[]>>(
        { method: 'GET', url: '/api/v2/spot/trade/fills', query: params.toString() },
        creds
      );
      if (data.code !== '00000') {
        throw new ProviderError(
          `Bitget code=${data.code}: ${data.msg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = data.data ?? [];
      for (const row of rows) yield row;
      if (rows.length < PAGE_LIMIT) break;
      const last = rows[rows.length - 1];
      if (!last?.tradeId) break;
      idLessThan = last.tradeId;
    }
  }

  private async *iterateDeposits(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BitgetDepositRow> {
    let idLessThan: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        startTime: since.getTime().toString(),
        endTime: until.getTime().toString(),
        limit: PAGE_LIMIT.toString(),
      });
      if (idLessThan) params.set('idLessThan', idLessThan);
      const data = await this.signedJson<BitgetEnvelope<BitgetDepositRow[]>>(
        { method: 'GET', url: '/api/v2/spot/wallet/deposit-records', query: params.toString() },
        creds
      );
      if (data.code !== '00000') {
        throw new ProviderError(
          `Bitget code=${data.code}: ${data.msg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = data.data ?? [];
      for (const row of rows) yield row;
      if (rows.length < PAGE_LIMIT) break;
      const last = rows[rows.length - 1];
      if (!last?.orderId) break;
      idLessThan = last.orderId;
    }
  }

  private async *iterateWithdrawals(
    creds: ApiKeyCreds,
    since: Date,
    until: Date
  ): AsyncGenerator<BitgetWithdrawalRow> {
    let idLessThan: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        startTime: since.getTime().toString(),
        endTime: until.getTime().toString(),
        limit: PAGE_LIMIT.toString(),
      });
      if (idLessThan) params.set('idLessThan', idLessThan);
      const data = await this.signedJson<BitgetEnvelope<BitgetWithdrawalRow[]>>(
        { method: 'GET', url: '/api/v2/spot/wallet/withdrawal-records', query: params.toString() },
        creds
      );
      if (data.code !== '00000') {
        throw new ProviderError(
          `Bitget code=${data.code}: ${data.msg}`,
          'unrecoverable',
          this.providerKey
        );
      }
      const rows = data.data ?? [];
      for (const row of rows) yield row;
      if (rows.length < PAGE_LIMIT) break;
      const last = rows[rows.length - 1];
      if (!last?.orderId) break;
      idLessThan = last.orderId;
    }
  }

  private mapFill(fill: BitgetFill): TransactionEvent | null {
    const split = splitConcatenatedPair(fill.symbol);
    if (!split) return null;
    const sideUpper = String(fill.side ?? '').toUpperCase();
    const kind: TransactionEvent['kind'] = sideUpper === 'BUY' ? 'buy' : 'sell';
    const baseAmount = fill.baseVolume ?? fill.size ?? '0';
    const quoteAmount = fill.quoteVolume ?? fill.amount ?? '0';
    const primaryQty = enforceSign(baseAmount, kind);
    const counterQty = inferCounterSign(primaryQty, quoteAmount);

    let fee: TransactionEvent['fee'];
    const totalFeeRaw = fill.feeDetail?.totalFee ?? fill.feeDetail?.totalDeductionFee;
    const feeCoin = fill.feeDetail?.feeCoin || split.quote;
    if (totalFeeRaw && !new Decimal(totalFeeRaw).isZero()) {
      fee = {
        tokenIdentity: this.coinIdentity(feeCoin),
        quantity: negateFee(totalFeeRaw),
      };
    }

    const priceStr = fill.priceAvg || fill.price;
    return {
      externalId: fill.tradeId,
      occurredAt: new Date(Number.parseInt(fill.cTime, 10) || Date.now()),
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
      priceNative: priceStr
        ? { value: priceStr, quoteIdentity: this.coinIdentity(split.quote) }
        : undefined,
      rawPayload: fill,
    };
  }

  private mapDeposit(row: BitgetDepositRow): TransactionEvent {
    const ts = row.uTime ?? row.cTime ?? '0';
    const txId = row.tradeId;
    return {
      externalId: txId && txId.length > 0 ? txId : `deposit-${row.orderId}`,
      occurredAt: new Date(Number.parseInt(ts, 10) || Date.now()),
      kind: 'deposit',
      primary: {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: enforceSign(row.size, 'deposit'),
      },
      rawPayload: row,
    };
  }

  private mapWithdrawal(row: BitgetWithdrawalRow): TransactionEvent {
    const ts = row.uTime ?? row.cTime ?? '0';
    let fee: TransactionEvent['fee'];
    if (row.fee && !new Decimal(row.fee).isZero()) {
      fee = {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: negateFee(row.fee),
      };
    }
    return {
      externalId: row.orderId,
      occurredAt: new Date(Number.parseInt(ts, 10) || Date.now()),
      kind: 'withdraw',
      primary: {
        tokenIdentity: this.coinIdentity(row.coin),
        quantity: enforceSign(row.size, 'withdraw'),
      },
      fee,
      rawPayload: row,
    };
  }

  private coinIdentity(coin: string): Partial<NewToken> {
    return {
      symbol: coin.toUpperCase(),
      name: coin,
      providerMetadata: { bitget: { coin } },
    };
  }
}

export const bitgetFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'bitget-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'bitget-private',
    limiter,
    registeredFrom: 'providers/bitget',
    description: 'Bitget V2: 10 req / 1s per API key',
  });
  return new BitgetProvider(registered);
};
