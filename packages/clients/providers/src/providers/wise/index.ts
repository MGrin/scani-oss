/**
 * `WiseProvider` — Wise (formerly TransferWise) multi-currency
 * accounts.
 *
 * Auth: Bearer API token. The user pastes the personal/business API
 * token from Wise's developer settings; we use it as `Authorization: Bearer <token>`.
 *
 * Endpoints:
 *  - GET `/v2/profiles` — list user profiles (personal + business).
 *  - GET `/v4/profiles/{profileId}/balances?types=STANDARD` — multi-
 *    currency balances per profile.
 *  - GET `/v1/profiles/{profileId}/balance-statements/{balanceId}/statement.json`
 *    — per-balance ledger; window capped at 469 days, so multi-year
 *    histories are split into chunks.
 *
 * Wise is the canonical fiat-only provider — every balance is fiat
 * (no crypto), so the federated identity flow routes Wise holdings
 * to Frankfurter for historical pricing.
 *
 * Pre-refactor source:
 * `packages/integrations/src/services/WiseApiService.ts`.
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
import { wiseManifest } from './manifest';

export { wiseManifest } from './manifest';

const WISE_INSTITUTION_CODE = 'wise';
const WISE_BASE_URL = 'https://api.wise.com';
const STATEMENT_MAX_DAYS = 469;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_YEARS_MS = 5 * 365 * DAY_MS;

interface WiseProfile {
  id: number;
  type: 'PERSONAL' | 'BUSINESS';
  fullName: string;
}

interface WiseBalance {
  id: number;
  currency: string;
  amount: { value: number; currency: string };
  type: string;
}

interface WiseStatementAmount {
  value: number;
  currency: string;
}

interface WiseStatementTransaction {
  type: 'CREDIT' | 'DEBIT';
  date: string;
  amount: WiseStatementAmount;
  totalFees?: WiseStatementAmount;
  details?: {
    type?: string;
    description?: string;
    [key: string]: unknown;
  };
  referenceNumber: string;
  runningBalance?: WiseStatementAmount;
  exchangeDetails?: {
    fromAmount?: WiseStatementAmount;
    toAmount?: WiseStatementAmount;
    rate?: number;
  };
}

interface WiseStatementResponse {
  transactions?: WiseStatementTransaction[];
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return {
    symbol,
    name: symbol,
    providerMetadata: { wise: { currency: symbol } },
  };
}

export class WiseProvider implements BalanceProvider, TransactionsProvider, CredentialValidator {
  readonly providerKey = 'wise';
  readonly manifest = wiseManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];

  private readonly baseUrl: string;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    baseUrl?: string
  ) {
    this.baseUrl = baseUrl ?? WISE_BASE_URL;
  }

  canFetchBalances(c: string): boolean {
    return c === WISE_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === WISE_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const apiToken =
      (creds.apiToken as string | undefined) ?? (creds.accessToken as string | undefined);
    if (!apiToken) return [];
    const subKey = credentialBucketKey(apiToken);

    const profiles = await this.fetchProfiles(apiToken, subKey);
    if (profiles.length === 0) return [];

    // Sum balances across all profiles + currencies. Wise users
    // typically have one personal + maybe one business; the loop is
    // small.
    const merged = new Map<string, Decimal>();
    for (const profile of profiles) {
      const balances = await this.fetchProfileBalances(apiToken, profile.id, subKey);
      for (const b of balances) {
        const code = b.currency.toUpperCase();
        const amt = new Decimal(b.amount.value);
        if (amt.lte(0)) continue;
        merged.set(code, (merged.get(code) ?? new Decimal(0)).plus(amt));
      }
    }

    const out: HoldingSnapshot[] = [];
    for (const [currency, total] of merged) {
      out.push({
        externalId: currency,
        tokenIdentity: tokenIdentity(currency),
        balance: total.toString(),
        capturedAt: new Date(),
        // Wise is fiat-only by design — every balance is a real currency,
        // so the import resolver routes to the existing fiat token row
        // instead of spawning a crypto duplicate that has no Frankfurter
        // pricing pipeline.
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
    const apiToken =
      (creds.apiToken as string | undefined) ?? (creds.accessToken as string | undefined);
    if (!apiToken) return [];
    const subKey = credentialBucketKey(apiToken);

    const until = ctx.until ?? new Date();
    const since = ctx.since ?? new Date(until.getTime() - FIVE_YEARS_MS);
    const windows = splitWindow(since, until, STATEMENT_MAX_DAYS);

    const profiles = await this.fetchProfiles(apiToken, subKey);
    if (profiles.length === 0) return [];

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    const push = (event: TransactionEvent | null): void => {
      if (!event) return;
      if (seen.has(event.externalId)) return;
      seen.add(event.externalId);
      events.push(event);
    };

    for (const profile of profiles) {
      const balances = await this.fetchProfileBalances(apiToken, profile.id, subKey);
      for (const balance of balances) {
        for (const w of windows) {
          const statement = await this.fetchStatement(
            apiToken,
            profile.id,
            balance.id,
            balance.currency,
            w.start,
            w.end,
            subKey
          );
          const txs = statement.transactions ?? [];
          for (let i = 0; i < txs.length; i++) {
            const tx = txs[i];
            if (!tx) continue;
            const mapped = mapTransaction(tx, i);
            for (const m of mapped) push(m);
          }
        }
      }
    }
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== WISE_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiToken =
      (creds.apiToken as string | undefined) ?? (creds.accessToken as string | undefined);
    if (!apiToken) return { valid: false, message: 'apiToken required' };
    try {
      const subKey = credentialBucketKey(apiToken);
      const profiles = await this.fetchProfiles(apiToken, subKey);
      if (profiles.length === 0) {
        return { valid: false, message: 'Wise returned zero profiles for this token' };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private async fetchProfiles(apiToken: string, subKey: string): Promise<WiseProfile[]> {
    const response = await this.limiter.execute(
      async () =>
        fetch(`${this.baseUrl}/v2/profiles`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        }),
      subKey
    );
    if (!response.ok) throw new Error(`Wise profiles HTTP ${response.status}`);
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data as WiseProfile[];
  }

  private async fetchProfileBalances(
    apiToken: string,
    profileId: number,
    subKey: string
  ): Promise<WiseBalance[]> {
    const response = await this.limiter.execute(
      async () =>
        fetch(`${this.baseUrl}/v4/profiles/${profileId}/balances?types=STANDARD`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        }),
      subKey
    );
    if (!response.ok) throw new Error(`Wise balances HTTP ${response.status}`);
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data as WiseBalance[];
  }

  private async fetchStatement(
    apiToken: string,
    profileId: number,
    balanceId: number,
    currency: string,
    intervalStart: Date,
    intervalEnd: Date,
    subKey: string
  ): Promise<WiseStatementResponse> {
    const params = new URLSearchParams({
      currency: currency.toUpperCase(),
      intervalStart: intervalStart.toISOString(),
      intervalEnd: intervalEnd.toISOString(),
      type: 'COMPACT',
    });
    const url = `${this.baseUrl}/v1/profiles/${profileId}/balance-statements/${balanceId}/statement.json?${params.toString()}`;
    const response = await this.limiter.execute(
      async () =>
        fetch(url, {
          headers: { Authorization: `Bearer ${apiToken}` },
        }),
      subKey
    );
    if (!response.ok) throw new Error(`Wise statement HTTP ${response.status}`);
    const data = (await response.json()) as unknown;
    if (!data || typeof data !== 'object') return { transactions: [] };
    return data as WiseStatementResponse;
  }
}

/**
 * Split [start, end] into chunks of at most `maxDays` each. Wise's
 * statement endpoint refuses windows wider than 469 days.
 */
function splitWindow(
  start: Date,
  end: Date,
  maxDays: number
): readonly { start: Date; end: Date }[] {
  if (end.getTime() <= start.getTime()) return [];
  const maxMs = maxDays * DAY_MS;
  const chunks: { start: Date; end: Date }[] = [];
  let cursor = start.getTime();
  const endMs = end.getTime();
  while (cursor < endMs) {
    const next = Math.min(cursor + maxMs, endMs);
    chunks.push({ start: new Date(cursor), end: new Date(next) });
    cursor = next;
  }
  return chunks;
}

/**
 * Map a single Wise statement row to one or more `TransactionEvent`s.
 * Returns:
 *   - the primary event (deposit / withdraw / fee / swap_in / swap_out),
 *     or `null` if the row's type/details combination is not supported;
 *   - an optional sibling fee event when `totalFees.value > 0`.
 */
export function mapTransaction(
  tx: WiseStatementTransaction,
  index: number
): readonly TransactionEvent[] {
  const occurredAt = new Date(tx.date);
  const detailsType = (tx.details?.type ?? '').toUpperCase();
  const externalId = `${tx.referenceNumber}-${index}`;
  const amountAbs = new Decimal(tx.amount.value).abs();
  const currency = tx.amount.currency.toUpperCase();

  const primary = mapPrimary({
    txType: tx.type,
    detailsType,
    externalId,
    occurredAt,
    amountAbs,
    currency,
    raw: tx,
  });
  if (!primary) return [];

  const out: TransactionEvent[] = [primary];

  const fee = tx.totalFees;
  if (fee && new Decimal(fee.value).gt(0)) {
    const feeAbs = new Decimal(fee.value).abs();
    out.push({
      externalId: `${tx.referenceNumber}-fee`,
      occurredAt,
      kind: 'fee',
      primary: {
        tokenIdentity: tokenIdentity(fee.currency),
        quantity: feeAbs.neg().toString(),
      },
      rawPayload: { referenceNumber: tx.referenceNumber, totalFees: fee },
    });
  }

  return out;
}

function mapPrimary(input: {
  txType: 'CREDIT' | 'DEBIT';
  detailsType: string;
  externalId: string;
  occurredAt: Date;
  amountAbs: Decimal;
  currency: string;
  raw: WiseStatementTransaction;
}): TransactionEvent | null {
  const { txType, detailsType, externalId, occurredAt, amountAbs, currency, raw } = input;

  if (detailsType === 'CONVERSION') {
    const kind = txType === 'CREDIT' ? 'swap_in' : 'swap_out';
    const quantity = txType === 'CREDIT' ? amountAbs.toString() : amountAbs.neg().toString();
    return {
      externalId,
      occurredAt,
      kind,
      primary: { tokenIdentity: tokenIdentity(currency), quantity },
      rawPayload: raw,
    };
  }

  if (txType === 'CREDIT') {
    if (
      detailsType === 'DEPOSIT' ||
      detailsType === 'BANK_TRANSFER' ||
      detailsType === 'CARD_TOPUP'
    ) {
      return {
        externalId,
        occurredAt,
        kind: 'deposit',
        primary: { tokenIdentity: tokenIdentity(currency), quantity: amountAbs.toString() },
        rawPayload: raw,
      };
    }
    return null;
  }

  // DEBIT
  if (detailsType === 'CARD') {
    return {
      externalId,
      occurredAt,
      kind: 'fee',
      primary: { tokenIdentity: tokenIdentity(currency), quantity: amountAbs.neg().toString() },
      rawPayload: raw,
    };
  }
  if (detailsType === 'TRANSFER') {
    return {
      externalId,
      occurredAt,
      kind: 'withdraw',
      primary: { tokenIdentity: tokenIdentity(currency), quantity: amountAbs.neg().toString() },
      rawPayload: raw,
    };
  }
  return null;
}

export const wiseFactory: ProviderFactory = async (deps) => {
  // Wise: 60 req/min per token. Conservative 1 req/s.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'wise-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'wise-private',
    limiter,
    registeredFrom: 'providers/wise',
    description: 'Wise: 1 req / 1s per API token',
  });
  return new WiseProvider(registered, deps.env.SCANI_TESTNET_WISE_BASE_URL || undefined);
};
