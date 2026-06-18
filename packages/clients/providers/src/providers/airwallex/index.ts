/**
 * `AirwallexProvider` — Airwallex global business accounts (multi-
 * currency balances + a financial-transaction ledger).
 *
 * Auth: two-step. The user pastes their Client ID + API key from the
 * Airwallex web app; we exchange them for a short-lived bearer token
 * via `POST /api/v1/authentication/login` (headers `x-client-id` /
 * `x-api-key`). The token is valid ~30 minutes and reused for every
 * call in that window (`Authorization: Bearer <token>`).
 *
 * Endpoints:
 *  - POST `/api/v1/authentication/login` — exchange creds → bearer token.
 *  - GET  `/api/v1/balances/current` — per-currency balances.
 *  - GET  `/api/v1/financial_transactions` — paginated ledger, filtered
 *    by a created-at window.
 *
 * Like Wise, Airwallex is fiat-only — every balance is a real currency,
 * so holdings are tagged `tokenType: 'fiat'` and route to Frankfurter
 * for historical pricing.
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
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { airwallexManifest } from './manifest';

export { airwallexManifest } from './manifest';

const AIRWALLEX_INSTITUTION_CODE = 'airwallex';
const AIRWALLEX_BASE_URL = 'https://api.airwallex.com';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_YEARS_MS = 5 * 365 * DAY_MS;
const TRANSACTION_PAGE_SIZE = 200;
// Hard stop so a malformed `has_more` can never spin forever.
const MAX_TRANSACTION_PAGES = 500;
// Refresh a little before the documented 30-minute expiry to avoid
// racing a call against a token that expires mid-flight.
const TOKEN_REFRESH_SKEW_MS = 60_000;
const TOKEN_FALLBACK_TTL_MS = 25 * 60_000;

interface AirwallexLoginResponse {
  token: string;
  expires_at?: string;
}

interface AirwallexBalance {
  currency: string;
  available_amount?: number | string;
  total_amount?: number | string;
  pending_amount?: number | string;
  reserved_amount?: number | string;
}

interface AirwallexFinancialTransaction {
  id: string;
  amount?: number | string;
  currency?: string;
  /** e.g. DEPOSIT, PAYOUT, FEE, CONVERSION, REFUND, ADJUSTMENT. */
  source_type?: string;
  financial_transaction_type?: string;
  status?: string;
  created_at?: string;
  description?: string;
  [key: string]: unknown;
}

interface AirwallexTransactionPage {
  items?: AirwallexFinancialTransaction[];
  has_more?: boolean;
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return {
    symbol,
    name: symbol,
    providerMetadata: { airwallex: { currency: symbol } },
  };
}

/** Pick the most representative balance figure, preferring the total
 * (available + pending + reserved) when present so net-worth reflects
 * funds that are temporarily held, falling back to available. */
function pickBalance(b: AirwallexBalance): Decimal {
  const raw = b.total_amount ?? b.available_amount ?? 0;
  return new Decimal(raw);
}

export class AirwallexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'airwallex';
  readonly manifest = airwallexManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];

  private readonly baseUrl: string;
  // In-process bearer-token cache, keyed by the credential bucket. A
  // cache miss just costs one extra login, so a per-process map is
  // enough — no Redis token store required.
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly limiter: OutflowRateLimiter,
    baseUrl?: string
  ) {
    this.baseUrl = baseUrl ?? AIRWALLEX_BASE_URL;
  }

  canFetchBalances(c: string): boolean {
    return c === AIRWALLEX_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === AIRWALLEX_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const auth = this.readCredentials(creds);
    if (!auth) return [];

    const token = await this.authenticate(auth.clientId, auth.apiKey);
    const balances = await this.fetchCurrentBalances(token, auth.subKey);

    const out: HoldingSnapshot[] = [];
    for (const b of balances) {
      if (!b.currency) continue;
      const total = pickBalance(b);
      if (total.lte(0)) continue;
      out.push({
        externalId: b.currency.toUpperCase(),
        tokenIdentity: tokenIdentity(b.currency),
        balance: total.toString(),
        capturedAt: new Date(),
        tokenType: 'fiat',
      });
    }
    return out;
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const auth = this.readCredentials(creds);
    if (!auth) return [];

    const token = await this.authenticate(auth.clientId, auth.apiKey);
    const until = ctx.until ?? new Date();
    const since = ctx.since ?? new Date(until.getTime() - FIVE_YEARS_MS);

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
      const result = await this.fetchTransactionPage(token, auth.subKey, since, until, page);
      const items = result.items ?? [];
      for (const tx of items) {
        for (const event of mapTransaction(tx)) {
          if (seen.has(event.externalId)) continue;
          seen.add(event.externalId);
          events.push(event);
        }
      }
      if (!result.has_more || items.length === 0) break;
    }
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== AIRWALLEX_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const auth = this.readCredentials(creds);
    if (!auth) return { valid: false, message: 'clientId and apiKey required' };
    try {
      const token = await this.authenticate(auth.clientId, auth.apiKey);
      // A successful login proves the credential pair; probe balances so
      // we also surface a token lacking read scope at setup time.
      await this.fetchCurrentBalances(token, auth.subKey);
      return { valid: true };
    } catch (err) {
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private readCredentials(
    creds: DecryptedCredentials
  ): { clientId: string; apiKey: string; subKey: string } | null {
    const clientId = creds.clientId as string | undefined;
    const apiKey = (creds.apiKey as string | undefined) ?? (creds.apiSecret as string | undefined);
    if (!clientId || !apiKey) return null;
    return { clientId, apiKey, subKey: credentialBucketKey(`${clientId}:${apiKey}`) };
  }

  private async authenticate(clientId: string, apiKey: string): Promise<string> {
    const subKey = credentialBucketKey(`${clientId}:${apiKey}`);
    const cached = this.tokenCache.get(subKey);
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return cached.token;
    }

    const response = await this.limiter.execute(
      async () =>
        fetch(`${this.baseUrl}/api/v1/authentication/login`, {
          method: 'POST',
          headers: {
            'x-client-id': clientId,
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
        }),
      subKey
    );
    if (!response.ok) throw new Error(`Airwallex auth HTTP ${response.status}`);
    const data = (await response.json()) as AirwallexLoginResponse;
    if (!data?.token) throw new Error('Airwallex auth returned no token');
    const expiresAt = data.expires_at
      ? Date.parse(data.expires_at)
      : Date.now() + TOKEN_FALLBACK_TTL_MS;
    this.tokenCache.set(subKey, { token: data.token, expiresAt });
    return data.token;
  }

  private async fetchCurrentBalances(token: string, subKey: string): Promise<AirwallexBalance[]> {
    const response = await this.limiter.execute(
      async () =>
        fetch(`${this.baseUrl}/api/v1/balances/current`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      subKey
    );
    if (!response.ok) throw new Error(`Airwallex balances HTTP ${response.status}`);
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data as AirwallexBalance[];
  }

  private async fetchTransactionPage(
    token: string,
    subKey: string,
    from: Date,
    to: Date,
    page: number
  ): Promise<AirwallexTransactionPage> {
    const params = new URLSearchParams({
      from_created_at: from.toISOString(),
      to_created_at: to.toISOString(),
      page: String(page),
      page_size: String(TRANSACTION_PAGE_SIZE),
    });
    const url = `${this.baseUrl}/api/v1/financial_transactions?${params.toString()}`;
    const response = await this.limiter.execute(
      async () =>
        fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      subKey
    );
    if (!response.ok) throw new Error(`Airwallex transactions HTTP ${response.status}`);
    const data = (await response.json()) as unknown;
    if (Array.isArray(data)) return { items: data as AirwallexFinancialTransaction[] };
    if (data && typeof data === 'object') return data as AirwallexTransactionPage;
    return { items: [] };
  }
}

/**
 * Map a single Airwallex financial transaction to a `TransactionEvent`.
 * Airwallex amounts are signed (credits positive, debits negative), so
 * the sign carries the in/out-flow directly; `source_type` refines the
 * `kind`. Returns an empty array for zero-amount or currency-less rows.
 */
export function mapTransaction(tx: AirwallexFinancialTransaction): readonly TransactionEvent[] {
  const currency = (tx.currency ?? '').toUpperCase();
  if (!currency || !tx.created_at) return [];
  const amount = new Decimal(tx.amount ?? 0);
  if (amount.isZero()) return [];

  const sourceType = (tx.source_type ?? tx.financial_transaction_type ?? '').toUpperCase();
  return [
    {
      externalId: String(tx.id),
      occurredAt: new Date(tx.created_at),
      kind: classifyKind(sourceType, amount),
      primary: { tokenIdentity: tokenIdentity(currency), quantity: amount.toString() },
      rawPayload: tx,
    },
  ];
}

function classifyKind(sourceType: string, amount: Decimal): TransactionEvent['kind'] {
  const inflow = amount.gt(0);
  if (sourceType.includes('FEE')) return 'fee';
  if (sourceType.includes('CONVERSION') || sourceType.includes('FX')) {
    return inflow ? 'swap_in' : 'swap_out';
  }
  if (sourceType.includes('INTEREST')) return 'interest';
  return inflow ? 'deposit' : 'withdraw';
}

export const airwallexFactory: ProviderFactory = async (deps) => {
  // Airwallex API limits vary by tier; 1 req/s per credential is a safe
  // conservative bound that also paces the login + paginated reads.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'airwallex-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'airwallex-private',
    limiter,
    registeredFrom: 'providers/airwallex',
    description: 'Airwallex: 1 req / 1s per credential',
  });
  return new AirwallexProvider(registered, deps.env.SCANI_TESTNET_AIRWALLEX_BASE_URL || undefined);
};
