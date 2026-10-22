/**
 * `FioProvider` — one Fio banka account, read-only, for self-hosted Scani only
 * (SC-1732). The manifest's `selfHostedOnly` keeps it off the hosted product.
 *
 * A Fio "API token" covers one account. The only read used is
 * `GET /v1/rest/periods/{token}/{from}/{to}/transactions.json`: the statement
 * for a date range, with the closing balance in `info` and the movements in
 * `transactionList`. The "since the last download" read is never used,
 * because it moves a bookmark on Fio's side.
 *
 * Fio allows one call per token per 30 seconds (HTTP 409 otherwise), so the
 * statement a balance read fetches is kept briefly and the ledger read of the
 * same sync filters it rather than calling again.
 *
 * No sandbox exists; shapes follow Fio's API document (v1.9, 16. 10. 2025).
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
import { fioManifest } from './manifest';

const FIO_INSTITUTION_CODE = 'fio';
const FIO_SOURCE = 'fio-api';
const FIO_BASE_URL = 'https://fioapi.fio.cz/v1/rest';
const DAY_MS = 24 * 60 * 60 * 1000;
// Movements older than 90 days need an unlock in internetbanking first, so a
// run with no `since` reads 90 days, today included.
const DEFAULT_LOOKBACK_DAYS = 90;
// Long enough for one sync's balance read and ledger read to share a call.
const STATEMENT_REUSE_MS = 5 * 60 * 1000;

interface FioColumn<T> {
  value: T;
}

interface FioMovement {
  column22?: FioColumn<number> | null;
  column0?: FioColumn<string | number> | null;
  column1?: FioColumn<number> | null;
  column14?: FioColumn<string> | null;
  column2?: FioColumn<string> | null;
  column3?: FioColumn<string> | null;
  column10?: FioColumn<string> | null;
  column16?: FioColumn<string> | null;
  column8?: FioColumn<string> | null;
  column25?: FioColumn<string> | null;
}

interface FioStatement {
  accountStatement?: {
    info?: { currency?: string; closingBalance?: number };
    transactionList?: { transaction?: FioMovement[] | null };
  };
}

interface CachedStatement {
  from: string;
  to: string;
  statement: FioStatement;
  fetchedAt: number;
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return { symbol, name: symbol, providerMetadata: { fio: { currency: symbol } } };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Fio's date: "2026-10-01+0200" from the live API, or epoch milliseconds of
 * Prague midnight in the document's example. Either way the result is the
 * Prague day, YYYY-MM-DD.
 */
function fioDay(value: string | number | undefined): string | null {
  if (typeof value === 'number') return PRAGUE_DAY.format(new Date(value));
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return match?.[1] ?? null;
}

export class FioProvider implements BalanceProvider, TransactionsProvider, CredentialValidator {
  readonly providerKey = FIO_INSTITUTION_CODE;
  readonly manifest = fioManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  readonly transactionHistoryHorizonMs = DEFAULT_LOOKBACK_DAYS * DAY_MS;

  private readonly baseUrl: string;
  private readonly statements = new Map<string, CachedStatement>();

  constructor(
    private readonly limiter: OutflowRateLimiter,
    baseUrl?: string
  ) {
    this.baseUrl = baseUrl ?? FIO_BASE_URL;
  }

  canFetchBalances(c: string): boolean {
    return c === FIO_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === FIO_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const token = readToken(await ctx.resolveCredentials(ctx.credentialsRef));
    const today = isoDate(new Date());
    const statement =
      this.cached(token, (s) => s.to === today) ??
      (await this.fetchStatement(token, defaultFrom(), today));
    const info = statement.accountStatement?.info;
    if (!info?.currency || info.closingBalance === undefined) {
      throw new ProviderError(
        'Fio: the statement had no closing balance',
        'unrecoverable',
        FIO_INSTITUTION_CODE
      );
    }
    const balance = new Decimal(info.closingBalance);
    if (balance.lte(0)) return [];
    return [
      {
        externalId: info.currency.toUpperCase(),
        tokenIdentity: tokenIdentity(info.currency),
        balance: balance.toString(),
        capturedAt: new Date(),
        tokenType: 'fiat',
      },
    ];
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const token = readToken(await ctx.resolveCredentials(ctx.credentialsRef));
    const today = isoDate(new Date());
    const from = ctx.since ? isoDate(ctx.since) : defaultFrom();
    const to = ctx.until ? isoDate(ctx.until) : today;
    const statement =
      this.cached(token, (s) => s.from <= from && s.to >= to) ??
      (await this.fetchStatement(token, from, to));
    const currency = statement.accountStatement?.info?.currency ?? '';
    const events: TransactionEvent[] = [];
    for (const movement of statement.accountStatement?.transactionList?.transaction ?? []) {
      const event = mapMovement(movement, currency);
      if (!event) continue;
      if (ctx.since && event.occurredAt < ctx.since) continue;
      if (ctx.until && event.occurredAt > ctx.until) continue;
      events.push(event);
    }
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== FIO_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const token = creds.token;
    if (typeof token !== 'string' || token.length === 0) {
      return { valid: false, message: 'token required' };
    }
    try {
      const today = isoDate(new Date());
      await this.fetchStatement(token, today, today, { atConnect: true });
      return { valid: true };
    } catch (err) {
      return credentialRejection(err);
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private cached(token: string, fits: (s: CachedStatement) => boolean): FioStatement | null {
    const entry = this.statements.get(credentialBucketKey(token));
    if (!entry || Date.now() - entry.fetchedAt > STATEMENT_REUSE_MS || !fits(entry)) return null;
    return entry.statement;
  }

  private async fetchStatement(
    token: string,
    from: string,
    to: string,
    opts: { atConnect?: boolean } = {}
  ): Promise<FioStatement> {
    const subKey = credentialBucketKey(token);
    // The token is part of the path, so the URL is never put in an error.
    const response = await this.limiter.execute(
      async () =>
        fetch(
          `${this.baseUrl}/periods/${encodeURIComponent(token)}/${from}/${to}/transactions.json`,
          { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Scani' } }
        ),
      subKey
    );
    if (!response.ok) throw await toProviderError(response, opts.atConnect === true);
    const statement = (await response.json()) as FioStatement;
    this.statements.set(subKey, { from, to, statement, fetchedAt: Date.now() });
    return statement;
  }
}

function defaultFrom(): string {
  return isoDate(new Date(Date.now() - (DEFAULT_LOOKBACK_DAYS - 1) * DAY_MS));
}

function readToken(creds: DecryptedCredentials): string {
  if (typeof creds.token !== 'string' || creds.token.length === 0) {
    throw new ProviderError(
      'Fio: this connection has no API token — connect Fio again',
      'auth-failed',
      FIO_INSTITUTION_CODE
    );
  }
  return creds.token;
}

/**
 * 409 is Fio's 30-second rule, so it is a rate limit. A 500 has one meaning in
 * Fio's known error states: "Chyba indikuje neexistující nebo neaktivní token"
 * (API document, chapter 8). At connect that is a verdict. During a sync one
 * 500 may also be an outage, and an `auth-failed` key is not used again until
 * replaced (SC-1728), so it is a retryable suspect that the sync confirms with
 * a second 500 an hour later (SC-1733). Other 5xx answers suspect nothing.
 */
async function toProviderError(response: Response, atConnect: boolean): Promise<ProviderError> {
  const body = await response.text();
  if (response.status === 409) {
    return new ProviderError(
      'Fio: the token was used less than 30 seconds ago',
      'rate-limited',
      FIO_INSTITUTION_CODE,
      { status: 409, body }
    );
  }
  if (response.status === 500 && atConnect) {
    return new ProviderError(
      'Fio did not accept this token: it may not exist, or be expired or not active',
      'auth-failed',
      FIO_INSTITUTION_CODE,
      { status: 500, body }
    );
  }
  if (response.status === 500) {
    return new ProviderError(
      'Fio answered 500: the token may have expired or been turned off',
      'retryable',
      FIO_INSTITUTION_CODE,
      { status: 500, body, suspectCredential: true }
    );
  }
  return ProviderError.fromHttp(FIO_INSTITUTION_CODE, response, body);
}

/** One movement, keeping Fio's own sign: positive in, negative out. */
function mapMovement(movement: FioMovement, statementCurrency: string): TransactionEvent | null {
  const id = movement.column22?.value;
  const day = fioDay(movement.column0?.value);
  const amount = movement.column1?.value;
  const currency = movement.column14?.value ?? statementCurrency;
  if (id === undefined || !day || amount === undefined || !currency) return null;
  const quantity = new Decimal(amount);
  if (quantity.isZero()) return null;
  const raw = {
    id,
    date: day,
    amount,
    currency,
    counterpartyAccount: movement.column2?.value,
    bankCode: movement.column3?.value,
    counterpartyName: movement.column10?.value,
    message: movement.column16?.value,
    type: movement.column8?.value,
    comment: movement.column25?.value,
  };
  return {
    externalId: String(id),
    occurredAt: new Date(`${day}T23:59:59Z`),
    kind: quantity.gt(0) ? 'deposit' : 'withdraw',
    primary: { tokenIdentity: tokenIdentity(currency), quantity: quantity.toString() },
    rawPayload: raw,
    ...extractCounterparty(FIO_SOURCE, raw),
  };
}

export const fioFactory: ProviderFactory = async (deps) => {
  // "Konkrétní token lze použít pouze 1x pro čtení nebo zápis během 30
  // sekund" — one call per token per 30 seconds. Shared through Redis, so the
  // connect check and the first sync wait for each other.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 30_000,
    redis: deps.redis ?? undefined,
    namespace: 'fio-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'fio-private',
    limiter,
    registeredFrom: 'providers/fio',
    description: 'Fio: 1 req / 30s per token',
  });
  return new FioProvider(registered, deps.env.SCANI_TESTNET_FIO_BASE_URL || undefined);
};
