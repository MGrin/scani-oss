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
import { enforceSign } from '../../core/utils/enforce-tx-sign';
import { coinbaseManifest } from './manifest';

export { coinbaseManifest } from './manifest';

const COINBASE_INSTITUTION_CODE = 'coinbase';
const API_VERSION = '2024-01-01';
const ACCOUNTS_PAGE_LIMIT = 100;
const TX_PAGE_LIMIT = 100;
const MAX_ACCOUNT_PAGES = 50;
const MAX_TX_PAGES_PER_ACCOUNT = 200;

interface CoinbaseAmount {
  amount: string;
  currency: string;
}

interface CoinbaseAccount {
  id: string;
  name: string;
  type: string;
  currency: { code: string; name: string };
  balance: CoinbaseAmount;
}

interface CoinbaseAccountsResponse {
  data: CoinbaseAccount[];
  pagination: { next_uri: string | null };
}

interface CoinbaseTransaction {
  id: string;
  type: string;
  status?: string;
  amount: CoinbaseAmount;
  native_amount?: CoinbaseAmount;
  created_at: string;
  description?: string | null;
}

interface CoinbaseTransactionsResponse {
  data: CoinbaseTransaction[];
  pagination: { next_uri: string | null };
}

export class CoinbaseProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'coinbase';
  readonly manifest = coinbaseManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = 'https://api.coinbase.com';

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Coinbase signs the FULL path including query string (the
    // pagination next_uri may include query params).
    const queryStr = req.query ? `?${req.query}` : '';
    const preSign = timestamp + req.method + req.url + queryStr + (req.body ?? '');
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(preSign).digest('hex');
    return {
      'CB-ACCESS-KEY': creds.apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-VERSION': API_VERSION,
    };
  }

  canFetchBalances(c: string): boolean {
    return c === COINBASE_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const accounts = await this.fetchAllAccounts(creds);

    // Coinbase exposes one account per currency; multiple wallets of
    // the same currency are returned as separate rows. Sum them.
    const merged = new Map<string, Decimal>();
    for (const a of accounts) {
      const amt = new Decimal(a.balance.amount || '0');
      if (amt.lte(0)) continue;
      const code = a.balance.currency.toUpperCase();
      merged.set(code, (merged.get(code) ?? new Decimal(0)).plus(amt));
    }

    const out: HoldingSnapshot[] = [];
    for (const [code, total] of merged) {
      out.push({
        externalId: code,
        tokenIdentity: this.tokenIdentity(code),
        balance: total.toString(),
        capturedAt: new Date(),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === COINBASE_INSTITUTION_CODE;
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

    const accounts = await this.fetchAllAccounts(creds);
    const events: TransactionEvent[] = [];
    for (const account of accounts) {
      for await (const tx of this.iterateTransactions(creds, account.id)) {
        const event = this.mapTransaction(tx, account);
        if (!event) continue;
        if (ctx.since && event.occurredAt < ctx.since) continue;
        if (ctx.until && event.occurredAt > ctx.until) continue;
        events.push(event);
      }
    }
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== COINBASE_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };
    try {
      await this.signedFetch(
        { method: 'GET', url: '/v2/accounts', query: 'limit=1' },
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

  private async fetchAllAccounts(creds: ApiKeyCreds): Promise<CoinbaseAccount[]> {
    const all: CoinbaseAccount[] = [];
    let nextUri: string | null = `/v2/accounts?limit=${ACCOUNTS_PAGE_LIMIT}`;
    let pages = 0;

    while (nextUri && pages < MAX_ACCOUNT_PAGES) {
      // Coinbase's `next_uri` is a path+query; split for signing.
      const [path, query] = this.splitPathQuery(nextUri);
      const data = await this.signedJson<CoinbaseAccountsResponse>(
        { method: 'GET', url: path, query },
        creds
      );
      if (data.data) all.push(...data.data);
      nextUri = data.pagination?.next_uri ?? null;
      pages += 1;
    }
    return all;
  }

  private async *iterateTransactions(
    creds: ApiKeyCreds,
    accountId: string
  ): AsyncGenerator<CoinbaseTransaction> {
    let nextUri: string | null = `/v2/accounts/${accountId}/transactions?limit=${TX_PAGE_LIMIT}`;
    let pages = 0;

    while (nextUri && pages < MAX_TX_PAGES_PER_ACCOUNT) {
      const [path, query] = this.splitPathQuery(nextUri);
      const data = await this.signedJson<CoinbaseTransactionsResponse>(
        { method: 'GET', url: path, query },
        creds
      );
      if (data.data) {
        for (const tx of data.data) yield tx;
      }
      nextUri = data.pagination?.next_uri ?? null;
      pages += 1;
    }
  }

  private mapTransaction(
    tx: CoinbaseTransaction,
    account: CoinbaseAccount
  ): TransactionEvent | null {
    // Skip non-settled rows so a pending send can't double-count once
    // it later completes under the same id.
    if (tx.status && tx.status !== 'completed') return null;

    const kind = this.mapTransactionKind(tx);
    if (!kind) return null;

    const rawAmount = tx.amount?.amount ?? '0';
    const currency = (tx.amount?.currency ?? account.currency.code).toUpperCase();
    const quantity = this.signQuantity(rawAmount, kind);

    return {
      externalId: tx.id,
      occurredAt: new Date(tx.created_at),
      kind,
      primary: {
        tokenIdentity: this.tokenIdentity(currency),
        quantity,
      },
      rawPayload: tx,
    };
  }

  private mapTransactionKind(tx: CoinbaseTransaction): TransactionEvent['kind'] | null {
    switch (tx.type) {
      case 'buy':
        return 'buy';
      case 'sell':
        return 'sell';
      case 'fiat_deposit':
      case 'exchange_deposit':
      case 'pro_deposit':
        return 'deposit';
      case 'fiat_withdrawal':
      case 'exchange_withdrawal':
      case 'pro_withdrawal':
        return 'withdraw';
      case 'staking_reward':
        return 'reward';
      case 'interest':
        return 'interest';
      case 'send': {
        // Coinbase v2 signs `native_amount` (and `amount`) by direction:
        // negative = outgoing send, positive = incoming. Native may be
        // zero for unpriced assets — fall back to the asset amount sign.
        const native = new Decimal(tx.native_amount?.amount ?? '0');
        const fallback = new Decimal(tx.amount?.amount ?? '0');
        const direction = native.isZero() ? fallback : native;
        return direction.isNegative() ? 'transfer_out' : 'transfer_in';
      }
      default:
        return null;
    }
  }

  /**
   * Re-assert the ledger sign by `kind`. CEX-style kinds delegate to
   * the shared `enforceSign`; transfer legs are not in that helper's
   * domain so we normalize them here (the ledger invariant is
   * "negative quantity = outflow").
   */
  private signQuantity(rawQty: string, kind: TransactionEvent['kind']): string {
    if (kind === 'transfer_in') return new Decimal(rawQty).abs().toString();
    if (kind === 'transfer_out') {
      const abs = new Decimal(rawQty).abs();
      return abs.isZero() ? '0' : abs.neg().toString();
    }
    if (
      kind === 'buy' ||
      kind === 'sell' ||
      kind === 'deposit' ||
      kind === 'withdraw' ||
      kind === 'fee' ||
      kind === 'reward' ||
      kind === 'interest'
    ) {
      return enforceSign(rawQty, kind);
    }
    return new Decimal(rawQty).toString();
  }

  private tokenIdentity(currency: string): Partial<NewToken> {
    const code = currency.toUpperCase();
    return {
      symbol: code,
      name: code,
      providerMetadata: { coinbase: { currency: code } },
    };
  }

  private splitPathQuery(uri: string): [string, string | undefined] {
    const idx = uri.indexOf('?');
    if (idx === -1) return [uri, undefined];
    return [uri.slice(0, idx), uri.slice(idx + 1)];
  }
}

export const coinbaseFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'coinbase-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'coinbase-private',
    limiter,
    registeredFrom: 'providers/coinbase',
    description: 'Coinbase v2: 5 req / 1s per API key',
  });
  return new CoinbaseProvider(registered);
};
