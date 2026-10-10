import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { FeedInput, FeedWindowShape, NewFeedInput } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, exists, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { Service } from 'typedi';
// Type-only, so nothing links the repository to the contract or the planner at runtime.
import type { FeedBatch, FeedWindow } from '../services/feeds/feed-batch';
import type { AccountInputFacts, PlannedFeedInput } from '../services/foundation/plan-feed-inputs';
// Three constant modules that import nothing: the source strings themselves,
// rather than a copy of them here that could drift.
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  IMPORTED_HOLDING_SOURCE_PREFIX,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../services/holdings/balance-sync-sources';
import {
  EVM_WALLET_SOURCE,
  NON_EVM_WALLET_SOURCES,
  STATEMENT_LEDGER_SOURCE_PREFIX,
} from '../services/transactions/transaction-source';
import { CEX_SOURCE_TO_INSTITUTION } from '../services/transactions/transaction-sources';

const CEX_LEDGER_SOURCES = Object.keys(CEX_SOURCE_TO_INSTITUTION);
const WALLET_LEDGER_SOURCES = [EVM_WALLET_SOURCE, ...NON_EVM_WALLET_SOURCES];

/**
 * Which of a user's accounts to read: the ones given, the ones at an
 * institution (a credential's, which is per user and institution), or the
 * ones whose `metadata.userWalletId` names a wallet.
 */
export type InputAccountScope =
  | { accountIds: readonly string[] }
  | { institutionId: string }
  | { walletId: string };

/** The feed inputs of D-7: one row per (account, source). */

const LEDGER_WINDOW_SHAPE: FeedWindowShape = 'transaction-run';
@Service()
export class FeedInputRepository extends BaseRepository<FeedInput, NewFeedInput> {
  protected readonly table = schema.feedInputs;
  protected readonly tableName = 'feed_inputs';

  /**
   * What `planFeedInputs` needs to know of every account the user has. The
   * credential is per (user, institution), so it is the account's whenever
   * the account sits at that institution. A wallet is the account's only
   * when `metadata.userWalletId` names one of the user's own wallets.
   */
  async findAccountInputFacts(
    userId: string,
    tx?: DatabaseTransaction,
    scope?: InputAccountScope
  ): Promise<AccountInputFacts[]> {
    if (scope && 'accountIds' in scope && scope.accountIds.length === 0) return [];
    const database = this.getDb(tx);
    const accounts = schema.accounts;
    const holdings = schema.holdings;
    const ledger = schema.holdingTransactions;
    const obs = schema.holdingBalanceObservations;
    const wallets = schema.userWallets;
    const credentials = schema.userIntegrationCredentials;

    const anyHolding = (condition: SQL) =>
      exists(
        database
          .select({ one: sql`1` })
          .from(holdings)
          .where(and(eq(holdings.accountId, accounts.id), condition))
      );
    const anyLedgerRow = (condition: SQL) =>
      exists(
        database
          .select({ one: sql`1` })
          .from(ledger)
          .innerJoin(holdings, eq(holdings.id, ledger.holdingId))
          .where(and(eq(holdings.accountId, accounts.id), condition))
      );
    const anyObservation = (condition: SQL) =>
      exists(
        database
          .select({ one: sql`1` })
          .from(obs)
          .innerJoin(holdings, eq(holdings.id, obs.holdingId))
          .where(and(eq(holdings.accountId, accounts.id), condition))
      );

    const rows = await database
      .select({
        accountId: accounts.id,
        institutionName: schema.institutions.name,
        chainId: sql<string | null>`${accounts.metadata}->>'chainId'`,
        walletId: wallets.id,
        walletActive: wallets.isActive,
        credentialId: credentials.id,
        credentialActive: credentials.isActive,
        // The K1 holdings a provider writes: its balance sync and its importers.
        hasProviderHoldings: sql<boolean>`${anyHolding(
          sql`(${holdings.source} = ${EXCHANGE_BALANCE_SYNC_SOURCE} OR starts_with(${holdings.source}, ${IMPORTED_HOLDING_SOURCE_PREFIX}))`
        )}`,
        hasCexLedger: sql<boolean>`${anyLedgerRow(inArray(ledger.source, CEX_LEDGER_SOURCES))}`,
        // A wallet's balance sync, or its chain's ledger rows.
        hasWalletEvidence: sql<boolean>`(${anyHolding(
          eq(holdings.source, WALLET_BALANCE_SYNC_SOURCE)
        )} OR ${anyLedgerRow(inArray(ledger.source, WALLET_LEDGER_SOURCES))})`,
        // The rows a statement input is the source of (D-5 `statement-*`, D-6 O1).
        hasStatementEvidence: sql<boolean>`(${anyLedgerRow(
          sql`starts_with(${ledger.source}, ${STATEMENT_LEDGER_SOURCE_PREFIX})`
        )} OR ${anyObservation(sql`starts_with(${obs.source}, ${STATEMENT_LEDGER_SOURCE_PREFIX})`)})`,
      })
      .from(accounts)
      .innerJoin(schema.institutions, eq(schema.institutions.id, accounts.institutionId))
      // On the text, not `::uuid`: one malformed pointer must not abort the read.
      .leftJoin(
        wallets,
        and(
          sql`${wallets.id}::text = ${accounts.metadata}->>'userWalletId'`,
          eq(wallets.userId, accounts.userId)
        )
      )
      .leftJoin(
        credentials,
        and(
          eq(credentials.userId, accounts.userId),
          eq(credentials.institutionId, accounts.institutionId)
        )
      )
      .where(and(eq(accounts.userId, userId), scope ? inScope(scope) : undefined))
      .orderBy(asc(accounts.id));

    return rows.map((r) => ({
      userId,
      accountId: r.accountId,
      institutionName: r.institutionName,
      chainId: r.chainId,
      walletId: r.walletId,
      walletActive: r.walletActive ?? false,
      credentialId: r.credentialId,
      credentialActive: r.credentialActive ?? false,
      hasProviderHoldings: r.hasProviderHoldings,
      hasCexLedger: r.hasCexLedger,
      hasStatementEvidence: r.hasStatementEvidence,
      hasWalletEvidence: r.hasWalletEvidence,
    }));
  }

  /**
   * Takes the credential at the account's institution FOR SHARE, when the user
   * has one. A connect or a disconnect writes that row, so it waits for the
   * caller's transaction, and one still uncommitted is waited for here: what
   * the caller reads next of the credential is what it is, until it commits.
   */
  async lockCredentialOf(
    userId: string,
    accountId: string,
    tx: DatabaseTransaction
  ): Promise<void> {
    const credentials = schema.userIntegrationCredentials;
    await this.getDb(tx)
      .select({ id: credentials.id })
      .from(credentials)
      .innerJoin(
        schema.accounts,
        and(
          eq(schema.accounts.userId, credentials.userId),
          eq(schema.accounts.institutionId, credentials.institutionId)
        )
      )
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
      .for('share', { of: credentials });
  }

  /** The user's inputs, in (account, source) order. */
  async findByUser(userId: string, tx?: DatabaseTransaction): Promise<FeedInput[]> {
    return this.getDb(tx)
      .select()
      .from(schema.feedInputs)
      .where(eq(schema.feedInputs.userId, userId))
      .orderBy(asc(schema.feedInputs.accountId), asc(schema.feedInputs.source));
  }

  /** Whether any input feeds the account, whatever its source or status. */
  async accountHasInput(
    userId: string,
    accountId: string,
    tx: DatabaseTransaction
  ): Promise<boolean> {
    const [found] = await this.getDb(tx)
      .select({ id: schema.feedInputs.id })
      .from(schema.feedInputs)
      .where(and(eq(schema.feedInputs.userId, userId), eq(schema.feedInputs.accountId, accountId)))
      .limit(1);
    return found !== undefined;
  }

  /** Inserts the planned inputs that do not exist yet; returns how many it inserted. */
  async insertMissing(
    planned: readonly PlannedFeedInput[],
    tx: DatabaseTransaction
  ): Promise<number> {
    if (planned.length === 0) return 0;
    const inserted = await this.getDb(tx)
      .insert(schema.feedInputs)
      .values(
        planned.map((p) => ({
          userId: p.userId,
          accountId: p.accountId,
          source: p.source,
          credentialId: p.credentialId,
          walletId: p.walletId,
          status: p.status,
        }))
      )
      .onConflictDoNothing({ target: [schema.feedInputs.accountId, schema.feedInputs.source] })
      .returning({ id: schema.feedInputs.id });
    return inserted.length;
  }

  /**
   * Brings each planned input that exists up to its plan (D-11): a NULL
   * credential or wallet is linked (R39) and the status becomes the plan's.
   * A reference already set is kept, and an input the plan does not name is
   * not touched. Returns how many inputs changed; one already current is not
   * written, so its `updated_at` stays.
   *
   * One statement per input, in the plan's order, so two callers lock an
   * account's inputs in the same order.
   */
  async linkAndSetStatus(
    planned: readonly PlannedFeedInput[],
    tx: DatabaseTransaction
  ): Promise<number> {
    const inputs = schema.feedInputs;
    let changed = 0;
    for (const p of planned) {
      const updated = await this.getDb(tx)
        .update(inputs)
        .set({
          credentialId: sql`COALESCE(${inputs.credentialId}, ${p.credentialId}::uuid)`,
          walletId: sql`COALESCE(${inputs.walletId}, ${p.walletId}::uuid)`,
          status: p.status,
          updatedAt: sql`now()`,
        })
        .where(behindItsPlan(p))
        .returning({ id: inputs.id });
      changed += updated.length;
    }
    return changed;
  }

  /** How many inputs `linkAndSetStatus` would change, for a run that writes nothing. */
  async countBehindTheirPlan(
    planned: readonly PlannedFeedInput[],
    tx: DatabaseTransaction
  ): Promise<number> {
    let behind = 0;
    for (const p of planned) {
      const found = await this.getDb(tx)
        .select({ id: schema.feedInputs.id })
        .from(schema.feedInputs)
        .where(behindItsPlan(p));
      behind += found.length;
    }
    return behind;
  }

  /**
   * The account's input for `source`, created active when it has none (D-11).
   * An input is the account's, so one that belongs to another user means the
   * batch named an account that is not its user's, and nothing is written.
   *
   * Locked until the caller's transaction ends, so two writes of one input run
   * one after the other: the second then finds the holdings the first created
   * rather than creating its own beside them (A2 N2). NO KEY UPDATE, because
   * every ledger row naming the input takes a KEY SHARE lock on it for its
   * foreign key, and those must not wait on this.
   */
  async findOrCreate(
    input: FeedBatch['input'] & { userId: string },
    tx: DatabaseTransaction
  ): Promise<FeedInput> {
    await this.insertMissing([{ ...input, status: 'active' }], tx);
    const [found] = await this.getDb(tx)
      .select()
      .from(schema.feedInputs)
      .where(
        and(
          eq(schema.feedInputs.accountId, input.accountId),
          eq(schema.feedInputs.source, input.source)
        )
      )
      .for('no key update');
    if (!found || found.userId !== input.userId) {
      throw new Error(
        `FeedInputRepository: user ${input.userId} has no input ${input.source} on account ${input.accountId}`
      );
    }
    return found;
  }

  /**
   * Where the last ledger read of this account and source stopped (SC-1665):
   * the newest 'transaction-run' window. A balance sync records a window on
   * the same input every hour, so the newest window of any shape follows the
   * balance and would skip every row posted since the last ledger read. `null`
   * when no ledger read is recorded: unknown, never the epoch.
   */
  async findLedgerReadThrough(
    accountId: string,
    source: string,
    tx?: DatabaseTransaction
  ): Promise<Date | null> {
    const windows = schema.feedInputWindows;
    const [row] = await this.getDb(tx)
      .select({ toAt: windows.toAt })
      .from(windows)
      .innerJoin(schema.feedInputs, eq(schema.feedInputs.id, windows.inputId))
      .where(
        and(
          eq(schema.feedInputs.accountId, accountId),
          eq(schema.feedInputs.source, source),
          eq(windows.shape, LEDGER_WINDOW_SHAPE)
        )
      )
      .orderBy(sql`${windows.toAt} desc`)
      .limit(1);
    return row?.toAt ?? null;
  }

  /**
   * Each holding's ledger read-through, for those whose account has an input
   * of one of `sources` (SC-1665). `null` when that ledger was never read. A
   * holding with no such input is absent from the map.
   */
  async findLedgerReadThroughByHolding(
    holdingIds: readonly string[],
    sources: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<Map<string, Date | null>> {
    if (holdingIds.length === 0 || sources.length === 0) return new Map();
    const windows = schema.feedInputWindows;
    const rows = await this.getDb(tx)
      .select({
        holdingId: schema.holdings.id,
        readThrough: sql<Date | null>`max(${windows.toAt}) filter (where ${windows.shape} = ${LEDGER_WINDOW_SHAPE})`,
      })
      .from(schema.holdings)
      .innerJoin(schema.feedInputs, eq(schema.feedInputs.accountId, schema.holdings.accountId))
      .leftJoin(windows, eq(windows.inputId, schema.feedInputs.id))
      .where(
        and(
          inArray(schema.holdings.id, [...holdingIds]),
          inArray(schema.feedInputs.source, [...sources])
        )
      )
      .groupBy(schema.holdings.id);
    return new Map(
      rows.map((row) => [row.holdingId, row.readThrough ? new Date(row.readThrough) : null])
    );
  }

  /** One window per fetch (D-7): a fetch already recorded writes nothing and returns false. */
  async recordWindow(
    inputId: string,
    window: FeedWindow,
    fetchedAt: Date,
    tx: DatabaseTransaction
  ): Promise<boolean> {
    const inserted = await this.getDb(tx)
      .insert(schema.feedInputWindows)
      .values({
        inputId,
        fromAt: window.from,
        toAt: window.to,
        complete: window.complete,
        fetchedAt,
        uploadRef: window.uploadRef ?? null,
        shape: window.shape,
      })
      .onConflictDoNothing()
      .returning({ id: schema.feedInputWindows.id });
    return inserted.length > 0;
  }
}

/** The planned input as stored, where its status differs or it lacks a reference the plan has. */
function behindItsPlan(p: PlannedFeedInput): SQL | undefined {
  const inputs = schema.feedInputs;
  return and(
    eq(inputs.userId, p.userId),
    eq(inputs.accountId, p.accountId),
    eq(inputs.source, p.source),
    or(
      ne(inputs.status, p.status),
      p.credentialId === null ? undefined : isNull(inputs.credentialId),
      p.walletId === null ? undefined : isNull(inputs.walletId)
    )
  );
}

function inScope(scope: InputAccountScope): SQL {
  if ('accountIds' in scope) return inArray(schema.accounts.id, [...scope.accountIds]);
  if ('institutionId' in scope) return eq(schema.accounts.institutionId, scope.institutionId);
  return sql`${schema.accounts.metadata}->>'userWalletId' = ${scope.walletId}`;
}
