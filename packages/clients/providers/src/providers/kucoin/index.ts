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
import { mapKucoinBizType } from './biz-types';
import { kucoinManifest } from './manifest';

export { kucoinManifest } from './manifest';

const KUCOIN_INSTITUTION_CODE = 'kucoin';

const LEDGER_PAGE_SIZE = 500;
const HIST_PAGE_SIZE = 50;
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

interface KucoinHistDeposit {
  currency: string;
  createAt: number;
  amount: string;
  walletTxId?: string;
  isInner?: boolean;
  status?: string;
}

interface KucoinHistWithdrawal {
  id?: string;
  currency: string;
  createAt: number;
  amount: string;
  walletTxId?: string;
  isInner?: boolean;
  status?: string;
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return {
    symbol,
    name: symbol,
    providerMetadata: { kucoin: { currency: currency } },
  };
}

export function ledgerItemToEvent(item: KucoinLedgerItem): TransactionEvent | null {
  const amount = new Decimal(item.amount || '0');
  if (amount.isZero()) return null;
  const kind = mapKucoinBizType(item.bizType, amount.isPositive());

  const event: TransactionEvent = {
    externalId: `ledger:${item.id}`,
    occurredAt: new Date(item.createdAt),
    kind,
    primary: { tokenIdentity: tokenIdentity(item.currency), quantity: amount.toString() },
    rawPayload: item,
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

export function histDepositToEvent(item: KucoinHistDeposit): TransactionEvent {
  const amount = new Decimal(item.amount || '0').abs();
  const occurredAt = new Date(item.createAt * 1000);
  const idSeed = item.walletTxId ?? `${item.currency}-${item.createAt}-${item.amount}`;
  return {
    externalId: `hist-deposit:${idSeed}`,
    occurredAt,
    kind: 'deposit',
    primary: { tokenIdentity: tokenIdentity(item.currency), quantity: amount.toString() },
    rawPayload: item,
  };
}

export function histWithdrawalToEvent(item: KucoinHistWithdrawal): TransactionEvent {
  const amount = new Decimal(item.amount || '0').abs().neg();
  const occurredAt = new Date(item.createAt * 1000);
  const idSeed = item.id ?? item.walletTxId ?? `${item.currency}-${item.createAt}-${item.amount}`;
  return {
    externalId: `hist-withdrawal:${idSeed}`,
    occurredAt,
    kind: 'withdraw',
    primary: { tokenIdentity: tokenIdentity(item.currency), quantity: amount.toString() },
    rawPayload: item,
  };
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
      });
    }
    return out;
  }

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === KUCOIN_INSTITUTION_CODE;
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

    for await (const item of this.paginate<KucoinLedgerItem>(
      '/api/v1/accounts/ledgers',
      creds,
      LEDGER_PAGE_SIZE,
      startAt,
      endAt
    )) {
      push(ledgerItemToEvent(item));
    }

    for await (const item of this.paginate<KucoinHistDeposit>(
      '/api/v1/hist-deposits',
      creds,
      HIST_PAGE_SIZE,
      startAt,
      endAt
    )) {
      push(histDepositToEvent(item));
    }

    for await (const item of this.paginate<KucoinHistWithdrawal>(
      '/api/v1/hist-withdrawals',
      creds,
      HIST_PAGE_SIZE,
      startAt,
      endAt
    )) {
      push(histWithdrawalToEvent(item));
    }

    return events;
  }

  private async *paginate<T>(
    path: string,
    creds: ApiKeyCreds,
    pageSize: number,
    startAt: number | undefined,
    endAt: number | undefined
  ): AsyncGenerator<T> {
    let currentPage = 1;
    while (currentPage <= MAX_PAGES) {
      const params = new URLSearchParams({
        pageSize: String(pageSize),
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
      for (const item of items) yield item;

      const totalPage = data.data?.totalPage ?? 0;
      if (currentPage >= totalPage) break;
      if (items.length < pageSize) break;
      currentPage += 1;
    }
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
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
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
