/**
 * `BunqProvider` — bunq bank accounts, read-only, for self-hosted Scani only
 * (SC-1729). The manifest's `selfHostedOnly` is what keeps it off the hosted
 * product; this class does not know which product it runs in.
 *
 * Auth is bunq's own three-step registration of a personal API key:
 *
 *  1. POST `/v1/installation` — register a fresh RSA public key.
 *  2. POST `/v1/device-server` — register this server, with the key as secret.
 *     A standard key is tied to the IP address this comes from.
 *  3. POST `/v1/session-server` — the one signed request; returns a session
 *     token and the user id every read is scoped under.
 *
 * Steps 1 and 2 are limited to a few calls a day, so they run once, at connect
 * time: `validateCredentials` returns the installation token and private key,
 * and the connect step stores them encrypted beside the key. A sync opens a
 * session and reads:
 *
 *  - GET `/v1/user/{id}/monetary-account` — every account, with its balance.
 *  - GET `/v1/user/{id}/monetary-account/{account}/payment` — newest first,
 *    paged through `Pagination.older_url`.
 *
 * Timestamps are UTC without a zone ("2026-10-11 16:41:11.893634"); measured
 * against bunq's own `Date` header on 2026-10-11.
 */

import crypto from 'node:crypto';
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
import { bunqManifest } from './manifest';

const BUNQ_INSTITUTION_CODE = 'bunq';
const BUNQ_SOURCE = 'bunq-api';
const BUNQ_BASE_URL = 'https://api.bunq.com';
const PAGE_SIZE = 200;
const MAX_PAYMENT_PAGES = 500;
// bunq extends a session on every call; re-opening after half an hour keeps a
// long-lived worker from holding one the user ended in the app.
const SESSION_REUSE_MS = 30 * 60 * 1000;

interface BunqAuth {
  apiKey: string;
  installationToken: string;
  privateKeyPem: string;
}

interface BunqSession {
  token: string;
  userId: number;
  subKey: string;
}

interface BunqAmount {
  currency: string;
  value: string;
}

interface BunqAccount {
  id: number;
  currency: string;
  balance?: BunqAmount;
}

interface BunqPayment {
  id: number;
  created: string;
  monetary_account_id?: number;
  amount: BunqAmount;
  description?: string;
  type?: string;
  sub_type?: string;
  counterparty_alias?: { display_name?: string; iban?: string };
}

interface BunqList {
  Response?: Array<Record<string, unknown>>;
  Pagination?: { older_url?: string | null };
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return { symbol, name: symbol, providerMetadata: { bunq: { currency: symbol } } };
}

/** The object inside each `{ <Kind>: {...} }` entry of a bunq list. */
function unwrap<T>(entry: Record<string, unknown>): T {
  return Object.values(entry)[0] as T;
}

/** "2026-10-11 16:41:11.893634" (UTC, no zone) → Date; null when unreadable. */
function parseBunqTime(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}${(match[3] ?? '').slice(0, 4)}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class BunqProvider implements BalanceProvider, TransactionsProvider, CredentialValidator {
  readonly providerKey = BUNQ_INSTITUTION_CODE;
  readonly manifest = bunqManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];

  private readonly baseUrl: string;
  private readonly sessions = new Map<string, BunqSession & { openedAt: number }>();

  constructor(
    private readonly limiter: OutflowRateLimiter,
    baseUrl?: string
  ) {
    this.baseUrl = baseUrl ?? BUNQ_BASE_URL;
  }

  canFetchBalances(c: string): boolean {
    return c === BUNQ_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === BUNQ_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const session = await this.openSession(
      readAuth(await ctx.resolveCredentials(ctx.credentialsRef))
    );
    const merged = new Map<string, Decimal>();
    for (const account of await this.fetchAccounts(session)) {
      const currency = (account.balance?.currency ?? account.currency).toUpperCase();
      const amount = new Decimal(account.balance?.value ?? 0);
      merged.set(currency, (merged.get(currency) ?? new Decimal(0)).plus(amount));
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
    const session = await this.openSession(
      readAuth(await ctx.resolveCredentials(ctx.credentialsRef))
    );
    const watch = new PageCapWatch();
    const events: TransactionEvent[] = [];
    for (const account of await this.fetchAccounts(session)) {
      let path: string | null =
        `/v1/user/${session.userId}/monetary-account/${account.id}/payment?count=${PAGE_SIZE}`;
      let rows = 0;
      let page = 0;
      for (; page < MAX_PAYMENT_PAGES && path; page++) {
        const list: BunqList = await this.get(path, session);
        const payments = (list.Response ?? []).map((entry) => unwrap<BunqPayment>(entry));
        let reachedSince = false;
        for (const payment of payments) {
          const event = mapPayment(payment);
          if (!event) continue;
          if (ctx.since && event.occurredAt < ctx.since) {
            reachedSince = true;
            continue;
          }
          if (ctx.until && event.occurredAt > ctx.until) continue;
          events.push(event);
          rows++;
        }
        path = reachedSince || payments.length === 0 ? null : (list.Pagination?.older_url ?? null);
      }
      if (path) {
        watch.note({
          walk: { kind: 'accountTransactions', account: String(account.id) },
          pages: page,
          rows,
        });
      }
    }
    watch.retract(ctx, BUNQ_INSTITUTION_CODE);
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string; credentials?: DecryptedCredentials }> {
    if (institutionCode !== BUNQ_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey;
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return { valid: false, message: 'apiKey required' };
    }
    try {
      const auth = await this.register(apiKey);
      // A session proves the registration; reading the accounts proves the
      // key can see them.
      await this.fetchAccounts(await this.openSession(auth));
      return { valid: true, credentials: { ...auth } };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private async register(apiKey: string): Promise<BunqAuth> {
    const subKey = credentialBucketKey(apiKey);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const installation: BunqList = await this.post(
      '/v1/installation',
      { client_public_key: publicKey },
      { subKey }
    );
    const installationToken = installation.Response?.map(
      (entry) => entry.Token as { token?: string }
    ).find((token) => token?.token)?.token;
    if (!installationToken) {
      throw new ProviderError(
        'bunq: installation returned no token',
        'unrecoverable',
        BUNQ_INSTITUTION_CODE
      );
    }
    await this.post(
      '/v1/device-server',
      { description: 'Scani', secret: apiKey },
      { subKey, auth: installationToken }
    );
    return { apiKey, installationToken, privateKeyPem: privateKey };
  }

  private async openSession(auth: BunqAuth): Promise<BunqSession> {
    const subKey = credentialBucketKey(`${auth.apiKey}:${auth.installationToken}`);
    const cached = this.sessions.get(subKey);
    if (cached && Date.now() - cached.openedAt < SESSION_REUSE_MS) return cached;

    const response: BunqList = await this.post(
      '/v1/session-server',
      { secret: auth.apiKey },
      { subKey, auth: auth.installationToken, signWith: auth.privateKeyPem }
    );
    const entries = response.Response ?? [];
    const token = entries
      .map((entry) => entry.Token as { token?: string })
      .find((t) => t?.token)?.token;
    const user = entries
      .filter((entry) => Object.keys(entry)[0]?.startsWith('User'))
      .map((entry) => unwrap<{ id?: number }>(entry))
      .find((u) => typeof u?.id === 'number');
    if (!token || !user?.id) {
      throw new ProviderError(
        'bunq: session returned no token or user',
        'unrecoverable',
        BUNQ_INSTITUTION_CODE
      );
    }
    const session = { token, userId: user.id, subKey, openedAt: Date.now() };
    this.sessions.set(subKey, session);
    return session;
  }

  private async fetchAccounts(session: BunqSession): Promise<BunqAccount[]> {
    // One page: bunq caps a user at well under 200 accounts.
    const list: BunqList = await this.get(
      `/v1/user/${session.userId}/monetary-account?count=${PAGE_SIZE}`,
      session
    );
    return (list.Response ?? []).map((entry) => unwrap<BunqAccount>(entry)).filter((a) => a?.id);
  }

  private async get(path: string, session: BunqSession): Promise<BunqList> {
    return this.call('GET', path, undefined, { subKey: session.subKey, auth: session.token });
  }

  private async post(
    path: string,
    body: unknown,
    opts: { subKey: string; auth?: string; signWith?: string }
  ): Promise<BunqList> {
    return this.call('POST', path, JSON.stringify(body), opts);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    opts: { subKey: string; auth?: string; signWith?: string }
  ): Promise<BunqList> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Scani',
      'X-Bunq-Client-Request-Id': crypto.randomUUID(),
      'X-Bunq-Language': 'en_US',
      'X-Bunq-Region': 'nl_NL',
      'X-Bunq-Geolocation': '0 0 0 0 000',
    };
    if (opts.auth) headers['X-Bunq-Client-Authentication'] = opts.auth;
    // bunq signs the body exactly as sent, so the signed string IS the body.
    if (opts.signWith && body !== undefined) {
      headers['X-Bunq-Client-Signature'] = crypto
        .createSign('RSA-SHA256')
        .update(body)
        .sign(opts.signWith, 'base64');
    }
    const response = await this.limiter.execute(
      async () => fetch(`${this.baseUrl}${path}`, { method, headers, body }),
      opts.subKey
    );
    if (!response.ok) throw await toProviderError(response);
    return (await response.json()) as BunqList;
  }
}

function readAuth(creds: DecryptedCredentials): BunqAuth {
  const { apiKey, installationToken, privateKeyPem } = creds;
  if (
    typeof apiKey !== 'string' ||
    typeof installationToken !== 'string' ||
    typeof privateKeyPem !== 'string'
  ) {
    // Only the connect step registers a key, so a credential without its
    // registration was stored some other way. Connecting again fixes it.
    throw new ProviderError(
      'bunq: this connection has no registered key — connect bunq again',
      'auth-failed',
      BUNQ_INSTITUTION_CODE
    );
  }
  return { apiKey, installationToken, privateKeyPem };
}

/**
 * bunq answers a wrong key, or a key used from an address it is not tied to,
 * with HTTP 400 rather than 401 (measured on the sandbox, 2026-10-11). That
 * answer is a verdict about the key, so it is `auth-failed`, in bunq's words.
 */
async function toProviderError(response: Response): Promise<ProviderError> {
  const body = await response.text();
  let description: string | undefined;
  try {
    const parsed = JSON.parse(body) as { Error?: Array<{ error_description?: string }> };
    description = parsed.Error?.find((e) => e.error_description)?.error_description;
  } catch {
    description = undefined;
  }
  if (response.status === 400 && description?.startsWith('User credentials are incorrect')) {
    return new ProviderError(`bunq: ${description}`, 'auth-failed', BUNQ_INSTITUTION_CODE, {
      status: response.status,
      body,
    });
  }
  return ProviderError.fromHttp(BUNQ_INSTITUTION_CODE, response, body);
}

/** One payment, signed from the account's side: positive in, negative out. */
function mapPayment(payment: BunqPayment): TransactionEvent | null {
  const occurredAt = parseBunqTime(payment.created);
  if (!occurredAt || !payment.amount?.currency) return null;
  const amount = new Decimal(payment.amount.value);
  if (amount.isZero()) return null;
  const raw = {
    id: payment.id,
    created: payment.created,
    monetary_account_id: payment.monetary_account_id,
    amount: payment.amount,
    description: payment.description,
    type: payment.type,
    sub_type: payment.sub_type,
    counterparty_alias: {
      display_name: payment.counterparty_alias?.display_name,
      iban: payment.counterparty_alias?.iban,
    },
  };
  return {
    externalId: String(payment.id),
    occurredAt,
    kind: amount.gt(0) ? 'deposit' : 'withdraw',
    primary: { tokenIdentity: tokenIdentity(payment.amount.currency), quantity: amount.toString() },
    rawPayload: raw,
    ...extractCounterparty(BUNQ_SOURCE, raw),
  };
}

export const bunqFactory: ProviderFactory = async (deps) => {
  // bunq: 3 GETs and 5 POSTs per 3 seconds per IP and endpoint. 1 req/s
  // stays under both.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'bunq-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'bunq-private',
    limiter,
    registeredFrom: 'providers/bunq',
    description: 'bunq: 1 req / 1s per API key',
  });
  return new BunqProvider(registered, deps.env.SCANI_TESTNET_BUNQ_BASE_URL || undefined);
};
