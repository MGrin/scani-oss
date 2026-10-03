import { createPrivateKey, type KeyObject, randomBytes, sign } from 'node:crypto';
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
import { enforceSign } from '../../core/utils/enforce-tx-sign';
import { tokenTypeForCexAsset } from '../../core/utils/fiat-codes';
import { PageCapWatch } from '../../core/utils/page-cap';
import { coinbaseManifest } from './manifest';

const COINBASE_INSTITUTION_CODE = 'coinbase';
const API_VERSION = '2024-01-01';
const API_HOST = 'api.coinbase.com';
const JWT_LIFETIME_SECONDS = 120;
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
  protected readonly baseUrl = `https://${API_HOST}`;

  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cdpJwt(req, creds)}`,
      'CB-VERSION': API_VERSION,
    };
  }

  /**
   * A Coinbase Developer Platform key authenticates one request at a time: an
   * ES256 JWT naming the key, valid for two minutes, bound to the request's
   * method, host and path. The query string is not part of `uri`.
   */
  private cdpJwt(req: SignedRequest, creds: ApiKeyCreds): string {
    const keyName = creds.apiKey.trim();
    const privateKey = this.cdpPrivateKey(creds.apiSecret);
    const nbf = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'ES256',
      typ: 'JWT',
      kid: keyName,
      nonce: randomBytes(16).toString('hex'),
    };
    const claims = {
      sub: keyName,
      iss: 'cdp',
      nbf,
      exp: nbf + JWT_LIFETIME_SECONDS,
      uri: `${req.method} ${API_HOST}${req.url}`,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  /**
   * Users copy `privateKey` out of the downloaded JSON, so it can arrive still
   * quoted and with its newlines as literal `\n` escapes.
   */
  private cdpPrivateKey(pasted: string): KeyObject {
    const pem = pasted.trim().replace(/^"|"$/g, '').replaceAll('\\n', '\n');
    let key: KeyObject | null = null;
    try {
      key = createPrivateKey(pem);
    } catch {}
    if (key?.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new ProviderError(
        'Coinbase private key must be the ECDSA (EC) privateKey value from the downloaded JSON; Ed25519 keys cannot sign Coinbase account requests',
        'auth-failed',
        this.providerKey
      );
    }
    return key;
  }

  canFetchBalances(c: string): boolean {
    return c === COINBASE_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    // `null`: a balance snapshot makes no claim about history, so a short
    // account list has no completeness claim to retract here.
    const accounts = await this.fetchAllAccounts(creds, null);

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
        tokenType: tokenTypeForCexAsset(code),
      });
    }
    return out;
  }

  canFetchTransactions(c: string): boolean {
    return c === COINBASE_INSTITUTION_CODE;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const capped = new PageCapWatch();
    const accounts = await this.fetchAllAccounts(creds, capped);
    const events: TransactionEvent[] = [];
    for (const account of accounts) {
      for await (const tx of this.iterateTransactions(creds, account.id, capped)) {
        const event = this.mapTransaction(tx, account);
        if (!event) continue;
        if (ctx.since && event.occurredAt < ctx.since) continue;
        if (ctx.until && event.occurredAt > ctx.until) continue;
        events.push(event);
      }
    }
    capped.retract(ctx, this.providerKey);
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
    if (!apiKey || !apiSecret) {
      return { valid: false, message: 'API key name and private key are required' };
    }
    try {
      await this.signedFetch(
        { method: 'GET', url: '/v2/accounts', query: 'limit=1' },
        { apiKey, apiSecret }
      );
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  private async fetchAllAccounts(
    creds: ApiKeyCreds,
    capped: PageCapWatch | null
  ): Promise<CoinbaseAccount[]> {
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
    // A `next_uri` still in hand means the loop exited on the cap, not on the
    // end of the list — whole accounts, and therefore whole ledgers, are
    // missing rather than merely truncated.
    if (nextUri) {
      capped?.note({ walk: { kind: 'accountList' }, pages: MAX_ACCOUNT_PAGES, rows: all.length });
    }
    return all;
  }

  private async *iterateTransactions(
    creds: ApiKeyCreds,
    accountId: string,
    capped: PageCapWatch
  ): AsyncGenerator<CoinbaseTransaction> {
    let nextUri: string | null = `/v2/accounts/${accountId}/transactions?limit=${TX_PAGE_LIMIT}`;
    let pages = 0;
    let rows = 0;

    while (nextUri && pages < MAX_TX_PAGES_PER_ACCOUNT) {
      const [path, query] = this.splitPathQuery(nextUri);
      const data = await this.signedJson<CoinbaseTransactionsResponse>(
        { method: 'GET', url: path, query },
        creds
      );
      if (data.data) {
        rows += data.data.length;
        for (const tx of data.data) yield tx;
      }
      nextUri = data.pagination?.next_uri ?? null;
      pages += 1;
    }
    if (nextUri) {
      capped.note({
        walk: { kind: 'accountTransactions', account: accountId },
        pages: MAX_TX_PAGES_PER_ACCOUNT,
        rows,
      });
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

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url');
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
