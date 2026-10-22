/**
 * `InvestecProvider` — Investec South Africa Private Bank accounts, read-only,
 * for self-hosted Scani only (SC-1731). The manifest's `selfHostedOnly` keeps
 * it off the hosted product; this class does not know which product it runs in.
 *
 * Auth is OAuth 2.0 client credentials: the customer's client id and secret,
 * Basic-encoded, plus their API key as `x-api-key`, exchanged at
 * `/identity/v2/oauth2/token` for a bearer token that lasts 30 minutes and has
 * no refresh token. The token response names the key's scopes, and the connect
 * step refuses a key that may transfer or pay.
 *
 * Reads, all GET under `/za/pb/v1`:
 *
 *  - `/accounts` — every account the key was given.
 *  - `/accounts/{id}/balance` — the balance and the account's currency.
 *  - `/accounts/{id}/transactions?fromDate&toDate` — posted rows, amounts
 *    always positive with `type` DEBIT or CREDIT, dates without a time.
 *
 * Shapes measured on Investec's sandbox, 2026-10-12.
 */

import type { NewToken } from '@scani/db/schema';
import {
  createOutflowLimiter,
  credentialBucketKey,
  type OutflowRateLimiter,
} from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import type { ProviderFactory } from '../../core/boot';
import type {
  BalanceProvider,
  Capability,
  CredentialValidator,
  TransactionsProvider,
} from '../../core/capabilities';
import { extractCounterparty } from '../../core/counterparty';
import { credentialRejection, ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { PageCapWatch } from '../../core/utils/page-cap';
import { investecManifest } from './manifest';

const INVESTEC_INSTITUTION_CODE = 'investec';
const INVESTEC_SOURCE = 'investec-api';
const INVESTEC_BASE_URL = 'https://openapi.investec.com';
const TOKEN_PATH = '/identity/v2/oauth2/token';
const DAY_MS = 24 * 60 * 60 * 1000;
// "Will default to today's date, minus 180 days, if not specified" — the
// `fromDate` parameter, Investec's API reference (2026-10-12).
const DEFAULT_LOOKBACK_MS = 180 * DAY_MS;
// Re-request a minute before Investec's 1799-second expiry.
const TOKEN_MARGIN_MS = 60 * 1000;
const WRITE_SCOPES = ['transfers', 'beneficiarypayments'];

interface InvestecAuth {
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

interface InvestecToken {
  value: string;
  subKey: string;
  expiresAt: number;
}

interface InvestecAccount {
  accountId: string;
}

interface InvestecBalance {
  currentBalance: number;
  currency: string;
}

interface InvestecTransaction {
  accountId?: string;
  type: string;
  transactionType?: string;
  status?: string;
  description?: string;
  postedOrder?: number;
  postingDate?: string;
  transactionDate?: string;
  valueDate?: string;
  amount: number;
  runningBalance?: number;
  uuid?: string;
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return { symbol, name: symbol, providerMetadata: { investec: { currency: symbol } } };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class InvestecProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = INVESTEC_INSTITUTION_CODE;
  readonly manifest = investecManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  readonly transactionHistoryHorizonMs = DEFAULT_LOOKBACK_MS;

  private readonly baseUrl: string;
  private readonly tokens = new Map<string, InvestecToken>();

  constructor(
    private readonly limiter: OutflowRateLimiter,
    baseUrl?: string
  ) {
    this.baseUrl = baseUrl ?? INVESTEC_BASE_URL;
  }

  canFetchBalances(c: string): boolean {
    return c === INVESTEC_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === INVESTEC_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const token = await this.token(readAuth(await ctx.resolveCredentials(ctx.credentialsRef)));
    const merged = new Map<string, Decimal>();
    for (const account of await this.fetchAccounts(token)) {
      const balance = await this.fetchBalance(token, account.accountId);
      const currency = balance.currency.toUpperCase();
      merged.set(
        currency,
        (merged.get(currency) ?? new Decimal(0)).plus(new Decimal(balance.currentBalance))
      );
    }
    const out: HoldingSnapshot[] = [];
    for (const [currency, total] of merged) {
      if (total.lte(0)) continue;
      out.push({
        externalId: currency,
        tokenIdentity: tokenIdentity(currency),
        balance: total.toString(),
        capturedAt: new Date(),
        tokenType: 'fiat',
      });
    }
    return out;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const token = await this.token(readAuth(await ctx.resolveCredentials(ctx.credentialsRef)));
    const query = new URLSearchParams({
      fromDate: isoDate(ctx.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS)),
    });
    if (ctx.until) query.set('toDate', isoDate(ctx.until));

    const watch = new PageCapWatch();
    const events: TransactionEvent[] = [];
    for (const account of await this.fetchAccounts(token)) {
      const { currency } = await this.fetchBalance(token, account.accountId);
      const body = (await this.get(
        `/za/pb/v1/accounts/${encodeURIComponent(account.accountId)}/transactions?${query}`,
        token
      )) as { data?: { transactions?: InvestecTransaction[] }; meta?: { totalPages?: number } };
      let rows = 0;
      for (const row of body.data?.transactions ?? []) {
        const event = mapTransaction(row, account.accountId, currency);
        if (!event) continue;
        if (ctx.since && event.occurredAt < ctx.since) continue;
        if (ctx.until && event.occurredAt > ctx.until) continue;
        events.push(event);
        rows++;
      }
      // Investec has no page parameter, so rows past the first page cannot be
      // asked for.
      if ((body.meta?.totalPages ?? 1) > 1) {
        watch.note({
          walk: { kind: 'accountTransactions', account: account.accountId },
          pages: 1,
          rows,
        });
      }
    }
    watch.retract(ctx, INVESTEC_INSTITUTION_CODE);
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== INVESTEC_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const { clientId, clientSecret, apiKey } = creds;
    if (
      typeof clientId !== 'string' ||
      !clientId ||
      typeof clientSecret !== 'string' ||
      !clientSecret ||
      typeof apiKey !== 'string' ||
      !apiKey
    ) {
      return { valid: false, message: 'clientId, clientSecret and apiKey required' };
    }
    try {
      const { token, scopes } = await this.requestToken({ clientId, clientSecret, apiKey });
      const writes = WRITE_SCOPES.filter((scope) => scopes.includes(scope));
      if (writes.length > 0) {
        return {
          valid: false,
          message: `This API key can move money (${writes.join(', ')}). Create a key with only account name and number, balance and transaction access.`,
        };
      }
      this.tokens.set(token.subKey, token);
      await this.fetchAccounts(token);
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private async token(auth: InvestecAuth): Promise<InvestecToken> {
    const cached = this.tokens.get(subKeyFor(auth));
    if (cached && cached.expiresAt > Date.now()) return cached;
    const { token } = await this.requestToken(auth);
    this.tokens.set(token.subKey, token);
    return token;
  }

  private async requestToken(
    auth: InvestecAuth
  ): Promise<{ token: InvestecToken; scopes: string[] }> {
    const subKey = subKeyFor(auth);
    const body = (await this.call({
      method: 'POST',
      path: TOKEN_PATH,
      subKey,
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`,
        'x-api-key': auth.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })) as { access_token?: string; expires_in?: number; scope?: string };
    if (!body.access_token) {
      throw new ProviderError(
        'Investec: the token response had no token',
        'unrecoverable',
        INVESTEC_INSTITUTION_CODE
      );
    }
    const lifetimeMs = (body.expires_in ?? 1799) * 1000;
    return {
      token: {
        value: body.access_token,
        subKey,
        expiresAt: Date.now() + lifetimeMs - TOKEN_MARGIN_MS,
      },
      scopes: (body.scope ?? '').split(/\s+/).filter(Boolean),
    };
  }

  private async fetchAccounts(token: InvestecToken): Promise<InvestecAccount[]> {
    const body = (await this.get('/za/pb/v1/accounts', token)) as {
      data?: { accounts?: InvestecAccount[] };
    };
    return (body.data?.accounts ?? []).filter((a) => a?.accountId);
  }

  private async fetchBalance(token: InvestecToken, accountId: string): Promise<InvestecBalance> {
    const body = (await this.get(
      `/za/pb/v1/accounts/${encodeURIComponent(accountId)}/balance`,
      token
    )) as { data?: InvestecBalance };
    if (!body.data?.currency) {
      throw new ProviderError(
        `Investec: account ${accountId} returned no balance currency`,
        'unrecoverable',
        INVESTEC_INSTITUTION_CODE
      );
    }
    return body.data;
  }

  private async get(path: string, token: InvestecToken): Promise<unknown> {
    return this.call({
      method: 'GET',
      path,
      subKey: token.subKey,
      headers: { Authorization: `Bearer ${token.value}` },
    });
  }

  private async call(req: {
    method: 'GET' | 'POST';
    path: string;
    subKey: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<unknown> {
    const response = await this.limiter.execute(
      async () =>
        fetch(`${this.baseUrl}${req.path}`, {
          method: req.method,
          headers: { Accept: 'application/json', 'User-Agent': 'Scani', ...req.headers },
          body: req.body,
        }),
      req.subKey
    );
    if (!response.ok) {
      throw ProviderError.fromHttp(INVESTEC_INSTITUTION_CODE, response, await response.text());
    }
    return response.json();
  }
}

function subKeyFor(auth: InvestecAuth): string {
  return credentialBucketKey(`${auth.clientId}:${auth.apiKey}`);
}

function readAuth(creds: DecryptedCredentials): InvestecAuth {
  const { clientId, clientSecret, apiKey } = creds;
  if (
    typeof clientId !== 'string' ||
    typeof clientSecret !== 'string' ||
    typeof apiKey !== 'string'
  ) {
    throw new ProviderError(
      'Investec: this connection is missing its client id, secret or API key — connect Investec again',
      'auth-failed',
      INVESTEC_INSTITUTION_CODE
    );
  }
  return { clientId, clientSecret, apiKey };
}

/**
 * One posted row, signed from the account's side: CREDIT in, DEBIT out. Rows
 * carry a date and no time, so they are stamped at the end of that UTC day,
 * the convention date-only rows use elsewhere.
 */
function mapTransaction(
  row: InvestecTransaction,
  accountId: string,
  currency: string
): TransactionEvent | null {
  if (row.status && row.status !== 'POSTED') return null;
  const date = row.postingDate ?? row.transactionDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const occurredAt = new Date(`${date}T23:59:59Z`);
  if (Number.isNaN(occurredAt.getTime())) return null;
  const magnitude = new Decimal(row.amount ?? 0).abs();
  if (magnitude.isZero()) return null;
  const isCredit = row.type === 'CREDIT';
  const raw = {
    uuid: row.uuid,
    accountId,
    type: row.type,
    transactionType: row.transactionType,
    status: row.status,
    description: row.description,
    postedOrder: row.postedOrder,
    postingDate: row.postingDate,
    transactionDate: row.transactionDate,
    valueDate: row.valueDate,
    amount: row.amount,
    runningBalance: row.runningBalance,
  };
  return {
    externalId: row.uuid ?? `${accountId}:${date}:${row.postedOrder ?? ''}`,
    occurredAt,
    kind: isCredit ? 'deposit' : 'withdraw',
    primary: {
      tokenIdentity: tokenIdentity(currency),
      quantity: (isCredit ? magnitude : magnitude.neg()).toString(),
    },
    rawPayload: raw,
    ...extractCounterparty(INVESTEC_SOURCE, raw),
  };
}

export const investecFactory: ProviderFactory = async (deps) => {
  // Investec publishes no number, only "429 … Too many requests in quick
  // succession". 1 req/s per key stays well clear.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'investec-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'investec-private',
    limiter,
    registeredFrom: 'providers/investec',
    description: 'Investec: 1 req / 1s per API key',
  });
  return new InvestecProvider(registered, deps.env.SCANI_TESTNET_INVESTEC_BASE_URL || undefined);
};
