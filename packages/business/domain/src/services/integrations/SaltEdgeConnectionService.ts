import { type DatabaseTransaction, getDb } from '@scani/db';
import { institutions, saltedgeConnections, saltedgeCustomers } from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { SaltEdgeProvider } from '@scani/providers/providers/saltedge';
import { and, asc, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { IntegrationCredentialsService } from '../users/IntegrationCredentialsService';

const INSTITUTION_NAME = 'Salt Edge';
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back a new connection asks the bank for; each bank caps it lower. */
const CONSENT_HISTORY_DAYS = 2 * 365;

function consentFromDate(now: Date): string {
  return new Date(now.getTime() - CONSENT_HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
}

type SaltEdgeCallbackKind = 'success' | 'fail' | 'notify' | 'destroy' | 'consent';

interface SaltEdgeCallbackData {
  connectionId: string;
  customerId: string;
  /** `error_class` on a fail callback; the revoke reason on a consent one. */
  errorClass?: string;
}

export interface SaltEdgeConnectionView {
  connectionId: string;
  status: string;
  lastError: string | null;
  updatedAt: Date;
  /** Anything but `active`: an expired or revoked consent, or a failed link. */
  needsReconnect: boolean;
}

type SaltEdgeCallbackOutcome =
  | { kind: 'applied'; userId: string; importNeeded: boolean }
  | { kind: 'ignored'; reason: 'unknown-customer' | 'progress-only' };

/**
 * A user's Salt Edge customer and bank connections (SC-1244).
 *
 * Callbacks arrive signed, keyed by Salt Edge's ids; this is where they become
 * rows. It never enqueues: `importNeeded` tells the HTTP handler to, because
 * request handlers enqueue and the worker processes.
 */
@Service()
export class SaltEdgeConnectionService {
  private readonly credentials = Container.get(IntegrationCredentialsService);
  private readonly registry = Container.get(ProviderRegistry);

  async ensureCustomer(userId: string, tx?: DatabaseTransaction): Promise<string> {
    const db = tx ?? getDb();
    const stored = async () =>
      (
        await db
          .select({ customerId: saltedgeCustomers.customerId })
          .from(saltedgeCustomers)
          .where(eq(saltedgeCustomers.userId, userId))
      )[0]?.customerId;

    const existing = await stored();
    if (existing) return existing;

    const created = await this.provider().createCustomer(userId);
    await db
      .insert(saltedgeCustomers)
      .values({ userId, customerId: created })
      .onConflictDoNothing();
    // A concurrent call may have won the insert; the stored row is the one both return.
    const kept = (await stored()) ?? created;
    // `enqueued`, not the default: nothing is imported until a bank is linked,
    // and a `pending_enqueue` row would be swept by the import reconciler.
    await this.credentials.storeCredentials(
      userId,
      await this.institutionId(tx),
      { customerId: kept },
      'saltedge_customer',
      undefined,
      'enqueued'
    );
    return kept;
  }

  /** The Salt Edge widget url to send the user to. */
  async startConnect(
    userId: string,
    returnTo: string,
    tx?: DatabaseTransaction,
    now = new Date()
  ): Promise<string> {
    const customerId = await this.ensureCustomer(userId, tx);
    return this.provider().createConnectSession({
      customerId,
      returnTo,
      fromDate: consentFromDate(now),
    });
  }

  /** The user's linked banks, oldest first. */
  async listConnections(
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<SaltEdgeConnectionView[]> {
    const rows = await (tx ?? getDb())
      .select({
        connectionId: saltedgeConnections.connectionId,
        status: saltedgeConnections.status,
        lastError: saltedgeConnections.lastError,
        updatedAt: saltedgeConnections.updatedAt,
      })
      .from(saltedgeConnections)
      .where(eq(saltedgeConnections.userId, userId))
      .orderBy(asc(saltedgeConnections.createdAt));
    return rows.map((row) => ({ ...row, needsReconnect: row.status !== 'active' }));
  }

  /**
   * The widget url that renews consent on one of the user's connections. The
   * ownership check comes first: a connection id is Salt Edge's, and a guessed
   * one must never open a session on someone else's bank.
   */
  async startReconnect(
    userId: string,
    connectionId: string,
    returnTo: string,
    tx?: DatabaseTransaction,
    now = new Date()
  ): Promise<string> {
    const [owned] = await (tx ?? getDb())
      .select({ id: saltedgeConnections.id })
      .from(saltedgeConnections)
      .where(
        and(
          eq(saltedgeConnections.userId, userId),
          eq(saltedgeConnections.connectionId, connectionId)
        )
      );
    if (!owned) throw new Error('Salt Edge connection not found');
    return this.provider().createReconnectSession({
      connectionId,
      returnTo,
      fromDate: consentFromDate(now),
    });
  }

  async applyCallback(
    kind: SaltEdgeCallbackKind,
    data: SaltEdgeCallbackData,
    tx?: DatabaseTransaction
  ): Promise<SaltEdgeCallbackOutcome> {
    const db = tx ?? getDb();
    const [customer] = await db
      .select({ userId: saltedgeCustomers.userId })
      .from(saltedgeCustomers)
      .where(eq(saltedgeCustomers.customerId, data.customerId));
    if (!customer) return { kind: 'ignored', reason: 'unknown-customer' };
    const { userId } = customer;

    if (kind === 'notify') return { kind: 'ignored', reason: 'progress-only' };

    if (kind === 'destroy') {
      await db
        .delete(saltedgeConnections)
        .where(eq(saltedgeConnections.connectionId, data.connectionId));
      return { kind: 'applied', userId, importNeeded: false };
    }

    const status = kind === 'success' ? 'active' : kind === 'fail' ? 'failed' : 'inactive';
    const lastError = kind === 'success' ? null : (data.errorClass ?? null);
    await db
      .insert(saltedgeConnections)
      .values({
        userId,
        customerId: data.customerId,
        connectionId: data.connectionId,
        status,
        lastError,
      })
      .onConflictDoUpdate({
        target: saltedgeConnections.connectionId,
        set: { status, lastError, updatedAt: new Date() },
      });
    return { kind: 'applied', userId, importNeeded: kind === 'success' };
  }

  private provider(): SaltEdgeProvider {
    const provider = this.registry.getBalanceFetcher('saltedge');
    if (!(provider instanceof SaltEdgeProvider)) {
      throw new Error('Salt Edge is not configured on this deployment');
    }
    return provider;
  }

  private async institutionId(tx?: DatabaseTransaction): Promise<string> {
    const [row] = await (tx ?? getDb())
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.name, INSTITUTION_NAME));
    if (!row) throw new Error(`Institution "${INSTITUTION_NAME}" is not seeded`);
    return row.id;
  }
}
