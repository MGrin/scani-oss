/**
 * `SaltEdgeProvider` — bank balances and transactions through Salt Edge's
 * account-information API (v6), under Salt Edge's licence (SC-1244).
 *
 * The user's side is not a credential form: a Salt Edge-hosted widget links a
 * bank to a Salt Edge *customer*, and the only per-user value Scani keeps is
 * that `customerId`. The platform's App-id, Secret and signing key come from
 * env, so an unkeyed deployment registers a provider that claims nothing.
 *
 * Balances are summed per currency across the customer's ACTIVE connections,
 * the same shape as Wise: the import path attaches one snapshot list to every
 * discovered account, so per-bank accounts wait for the sync-wiring step.
 * An inactive connection (expired or revoked consent) is skipped rather than
 * read, because Salt Edge serves its last-known data as if it were current.
 *
 * See `docs/technical/2026-09-19_saltedge-bank-aggregation-research.md`.
 */

import type { NewToken } from '@scani/db/schema';
import { createOutflowLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import type { ProviderFactory } from '../../core/boot';
import type { BalanceProvider, Capability, TransactionsProvider } from '../../core/capabilities';
import type { IntegrationManifest } from '../../core/integration-manifest';
import type {
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { SaltEdgeClient } from './client';
import { saltedgeManifest } from './manifest';

const INSTITUTION_CODE = 'saltedge';
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How far back a `since`-less run asks. Depth is per bank (`max_fetch_interval`,
 * 60 days by default) and bounded by the consent's `from_date`; asking for more
 * returns what exists, so this is the ceiling rather than a promise.
 */
const HISTORY_HORIZON_MS = 2 * 365 * DAY_MS;

interface SaltEdgeConnection {
  id: string;
  status: string;
}

interface SaltEdgeAccount {
  id: string;
  balance: number | string;
  currency_code: string;
}

interface SaltEdgeTransaction {
  id: string;
  made_on: string;
  amount: number | string;
  currency_code: string;
  status?: string;
  /** Read from the stored raw payload by the counterparty extractor. */
  description?: string;
  extra?: { payee?: string; payer?: string };
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return { symbol, name: symbol, providerMetadata: { saltedge: { currency: symbol } } };
}

export class SaltEdgeProvider implements BalanceProvider, TransactionsProvider {
  readonly providerKey = INSTITUTION_CODE;
  readonly capabilities: readonly Capability[] = ['current-balances', 'transactions'];
  readonly transactionHistoryHorizonMs = HISTORY_HORIZON_MS;

  /**
   * Only a keyed deployment lists Salt Edge among the integrations: an
   * unkeyed one would offer a button whose every press fails.
   */
  readonly manifest: IntegrationManifest | undefined;

  constructor(private readonly client: SaltEdgeClient | null) {
    this.manifest = client ? saltedgeManifest : undefined;
  }

  canFetchBalances(c: string): boolean {
    return this.client !== null && c === INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return this.client !== null && c === INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const accounts = await this.activeAccounts(ctx);
    const totals = new Map<string, Decimal>();
    for (const { account } of accounts) {
      const amount = new Decimal(account.balance);
      // A card or overdraft balance is a debt; there is no liability holding
      // to put it in, and a negative asset would subtract it from net worth
      // under the wrong name.
      if (amount.lte(0)) continue;
      const code = account.currency_code.toUpperCase();
      totals.set(code, (totals.get(code) ?? new Decimal(0)).plus(amount));
    }
    const capturedAt = new Date();
    return [...totals].map(([currency, total]) => ({
      externalId: currency,
      tokenIdentity: tokenIdentity(currency),
      balance: total.toString(),
      capturedAt,
      tokenType: 'fiat',
    }));
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string; since?: Date; until?: Date }
  ): Promise<TransactionEvent[]> {
    const until = ctx.until ?? new Date();
    const since = ctx.since ?? new Date(until.getTime() - HISTORY_HORIZON_MS);
    const events: TransactionEvent[] = [];
    for (const { connectionId, account } of await this.activeAccounts(ctx)) {
      const rows = await this.requireClient().list<SaltEdgeTransaction>('/api/v6/transactions', {
        connection_id: connectionId,
        account_id: account.id,
      });
      for (const row of rows) {
        const event = mapTransaction(row);
        if (!event) continue;
        if (event.occurredAt < since || event.occurredAt >= until) continue;
        events.push(event);
      }
    }
    return events;
  }

  /** One Salt Edge customer per Scani user; `identifier` is the user id. */
  async createCustomer(identifier: string): Promise<string> {
    const customer = await this.requireClient().post<{ customer_id: string }>('/api/v6/customers', {
      identifier,
    });
    return customer.customer_id;
  }

  /**
   * A session on Salt Edge's hosted widget, which is mandatory in v6: Scani
   * cannot render a bank login itself. The user is redirected to the returned
   * url, full page — an iframe breaks for OAuth banks.
   */
  async createConnectSession(input: {
    customerId: string;
    returnTo: string;
    fromDate: string;
  }): Promise<string> {
    const scopes = ['accounts', 'transactions'];
    const session = await this.requireClient().post<{ connect_url: string }>(
      '/api/v6/connections/connect',
      {
        customer_id: input.customerId,
        consent: { scopes, from_date: input.fromDate },
        attempt: {
          fetch_scopes: scopes,
          fetch_from_date: input.fromDate,
          return_to: input.returnTo,
        },
        // The return page reads it to tell a failed link from a good one.
        return_error_class: true,
      }
    );
    return session.connect_url;
  }

  /**
   * A widget session that renews consent on an existing connection, which is
   * how an `inactive` one (consent expired or revoked) comes back. Keeping the
   * connection keeps its accounts, so nothing already imported is duplicated.
   */
  async createReconnectSession(input: {
    connectionId: string;
    returnTo: string;
    fromDate: string;
  }): Promise<string> {
    const scopes = ['accounts', 'transactions'];
    const session = await this.requireClient().post<{ connect_url: string }>(
      `/api/v6/connections/${encodeURIComponent(input.connectionId)}/reconnect`,
      {
        consent: { scopes, from_date: input.fromDate },
        attempt: {
          fetch_scopes: scopes,
          fetch_from_date: input.fromDate,
          return_to: input.returnTo,
        },
        return_error_class: true,
      }
    );
    return session.connect_url;
  }

  private async activeAccounts(
    ctx: WithUserCreds<ProviderContext>
  ): Promise<{ connectionId: string; account: SaltEdgeAccount }[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const customerId = creds.customerId as string | undefined;
    if (!customerId) return [];
    const client = this.requireClient();
    const connections = await client.list<SaltEdgeConnection>('/api/v6/connections', {
      customer_id: customerId,
    });
    const out: { connectionId: string; account: SaltEdgeAccount }[] = [];
    for (const connection of connections) {
      if (connection.status !== 'active') continue;
      const accounts = await client.list<SaltEdgeAccount>('/api/v6/accounts', {
        connection_id: connection.id,
      });
      for (const account of accounts) out.push({ connectionId: connection.id, account });
    }
    return out;
  }

  private requireClient(): SaltEdgeClient {
    if (!this.client) throw new Error('Salt Edge is not configured on this deployment');
    return this.client;
  }
}

/** A posted row as a deposit or a withdrawal; a pending one is not yet a fact. */
function mapTransaction(row: SaltEdgeTransaction): TransactionEvent | null {
  if (row.status === 'pending') return null;
  const amount = new Decimal(row.amount);
  if (amount.isZero()) return null;
  return {
    externalId: row.id,
    occurredAt: new Date(`${row.made_on}T00:00:00Z`),
    kind: amount.gt(0) ? 'deposit' : 'withdraw',
    primary: { tokenIdentity: tokenIdentity(row.currency_code), quantity: amount.toString() },
    rawPayload: row,
  };
}

export const saltedgeFactory: ProviderFactory = async (deps) => {
  const appId = deps.env.SALTEDGE_APP_ID ?? '';
  const secret = deps.env.SALTEDGE_SECRET ?? '';
  const keyed = appId !== '' && secret !== '';
  deps.reportCredentialStatus({
    provider: INSTITUTION_CODE,
    envVar: 'SALTEDGE_APP_ID',
    keyed,
    degradedBehaviour: 'claims no institution; bank connections are unavailable',
  });
  if (!keyed) return new SaltEdgeProvider(null);
  // Salt Edge publishes rate limits only for its catalogue endpoints (10 rps);
  // 5 rps leaves the account-data calls well clear of any undocumented cap.
  const limiter = deps.rateLimiterRegistry.register({
    namespace: 'saltedge',
    limiter: createOutflowLimiter({
      maxRequests: 5,
      windowMs: 1000,
      redis: deps.redis ?? undefined,
      namespace: 'saltedge',
    }),
    registeredFrom: 'providers/saltedge',
    description: 'Salt Edge: 5 req / 1s',
  });
  return new SaltEdgeProvider(
    new SaltEdgeClient(
      { appId, secret, privateKeyPem: deps.env.SALTEDGE_PRIVATE_KEY || undefined },
      limiter,
      { baseUrl: deps.env.SALTEDGE_BASE_URL || undefined }
    )
  );
};
