import { type DatabaseTransaction, getDb } from '@scani/db';
import type { Account } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { BudgetAppAccount, BudgetAppRow, SkipReason } from '@scani/file-import';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
} from '../../repositories/EnumRepositories';
import { FeedInputRepository } from '../../repositories/FeedInputRepository';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { LinkTransferPairsUseCase } from '../../use-cases/LinkTransferPairsUseCase';
import { AccountService } from '../accounts/AccountService';
import { BalanceSyncOwnershipService } from '../accounts/BalanceSyncOwnershipService';
import { InstitutionService } from '../accounts/InstitutionService';
import { ImportedCategoryAssigner } from '../categories/ImportedCategoryAssigner';
import { FeedIngestService } from '../feeds/FeedIngestService';
import { HoldingCacheWriter } from '../feeds/HoldingCacheWriter';
import { budgetAppBatch } from '../feeds/imports/budget-app-batch';
import { inputSourceClass } from '../foundation/legacy-ledger-kinds';
import { type BudgetApp, budgetAppSource, planFeedInputs } from '../foundation/plan-feed-inputs';

export type BudgetAppAccountTarget =
  | { kind: 'new'; typeCode: string }
  | { kind: 'existing'; accountId: string }
  | { kind: 'skip' };

export interface BudgetAppImportRequest {
  userId: string;
  app: BudgetApp;
  uploadRef: string;
  /** The same for the same upload, so a retried job records no second window. */
  fetchedAt: Date;
  /** ISO code: the file's symbol as the person confirmed it. */
  currency: string;
  accounts: ReadonlyArray<{ name: string; target: BudgetAppAccountTarget }>;
  /** The rows the parser skipped, carried into the result the person sees. */
  skippedRows: ReadonlyArray<{ line: number; reason: SkipReason }>;
}

interface BudgetAppAccountSummary {
  name: string;
  accountId: string | null;
  created: boolean;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
}

export interface BudgetAppImportSummary {
  app: BudgetApp;
  currency: string;
  accounts: BudgetAppAccountSummary[];
  transfersPaired: number;
  /** Transfer rows whose other account was not imported, or not found: they enter the review queue. */
  transfersUnpaired: number;
  skippedRows: Array<{ line: number; reason: SkipReason }>;
  /** A register carries no budget; the person is told budgets are not imported (ruling Q5). */
  budgetsDropped: true;
}

export interface BudgetAppImportOutcome {
  importId: string;
  summary: BudgetAppImportSummary;
  holdingIds: string[];
  /** The currencies the rows landed in, whose rate history the rebuild needs. */
  tokenIds: string[];
  earliestChangedAt: Date | null;
}

export interface BudgetAppUndoOutcome {
  rowsRemoved: number;
  accountsRemoved: number;
  /** Created by the upload, kept because something else now writes to them. */
  accountsKept: number;
  holdingIds: string[];
  earliestChangedAt: Date | null;
}

export interface BudgetAppImportRecord {
  id: string;
  app: BudgetApp;
  summary: BudgetAppImportSummary;
  createdAt: Date;
  undoneAt: Date | null;
}

export interface BudgetAppImportTarget {
  id: string;
  name: string;
  typeName: string;
  /** False when a provider, a wallet or a live sync feeds the account. */
  eligible: boolean;
}

export type BudgetAppRefusal =
  | 'unknown-account'
  | 'account-not-found'
  | 'provider-fed'
  | 'unknown-currency'
  | 'unknown-account-type';

export class BudgetAppImportRefused extends Error {
  constructor(
    readonly reason: BudgetAppRefusal,
    readonly subject: string
  ) {
    super(`Budget app import refused: ${reason} (${subject})`);
    this.name = 'BudgetAppImportRefused';
  }
}

const APP_NAME: Record<BudgetApp, string> = {
  ynab: 'YNAB',
  actual: 'Actual Budget',
  mint: 'Mint',
};
const ENTRY_CHUNK = 5000;
const LISTED_IMPORTS = 20;

interface Landed {
  account: string;
  holdingId: string;
  row: BudgetAppRow;
  externalId: string;
}

/**
 * Imports a budget app's register into scani's ledger, one feed batch per
 * account inside the caller's transaction, and undoes one upload (SC-1649).
 * An account a provider or a wallet feeds is refused: its own feed already
 * books those movements, so the import would count them twice.
 */
@Service()
export class BudgetAppImportService {
  private readonly feeds = Container.get(FeedIngestService);
  private readonly accounts = Container.get(AccountRepository);
  private readonly accountService = Container.get(AccountService);
  private readonly institutions = Container.get(InstitutionService);
  private readonly accountTypes = Container.get(AccountTypeRepository);
  private readonly institutionTypes = Container.get(InstitutionTypeRepository);
  private readonly inputs = Container.get(FeedInputRepository);
  private readonly syncOwnership = Container.get(BalanceSyncOwnershipService);
  private readonly links = Container.get(LinkTransferPairsUseCase);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly coverage = Container.get(HoldingCoverageRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly categoryAssigner = Container.get(ImportedCategoryAssigner);

  async importRegister(
    request: BudgetAppImportRequest,
    parsed: readonly BudgetAppAccount[],
    tx: DatabaseTransaction
  ): Promise<BudgetAppImportOutcome> {
    const { userId, app } = request;
    const byName = new Map(parsed.map((account) => [account.name, account]));
    const chosen = request.accounts.filter((a) => a.target.kind !== 'skip');
    for (const { name } of chosen) {
      if (!byName.has(name)) throw new BudgetAppImportRefused('unknown-account', name);
    }
    await this.refuseFedAccounts(userId, chosen, tx);

    const summaries: BudgetAppAccountSummary[] = [];
    const landed: Landed[] = [];
    const inserted: string[] = [];
    const createdAccountIds: string[] = [];
    const holdingIds = new Set<string>();
    const tokenIds = new Set<string>();
    let earliestChangedAt: Date | null = null;

    for (const { name, target } of request.accounts) {
      const source = byName.get(name);
      if (!source) continue;
      if (target.kind === 'skip') {
        summaries.push({
          name,
          accountId: null,
          created: false,
          rowsRead: source.rows.length,
          rowsInserted: 0,
          rowsUpdated: 0,
        });
        continue;
      }
      const { accountId, created } =
        target.kind === 'existing'
          ? { accountId: target.accountId, created: false }
          : await this.ensureAccount(userId, app, name, target.typeCode, tx);
      if (created) createdAccountIds.push(accountId);

      const batch = budgetAppBatch({
        userId,
        accountId,
        app,
        currency: request.currency,
        rows: source.rows,
        uploadRef: request.uploadRef,
        fetchedAt: request.fetchedAt,
      });
      const result = await this.feeds.ingest(batch, tx);
      if (result.skippedAssets.length > 0) {
        throw new BudgetAppImportRefused('unknown-currency', request.currency);
      }
      const holdingId = result.holdings[0]?.holdingId;
      for (const id of result.touchedHoldingIds) holdingIds.add(id);
      for (const placed of result.holdings) tokenIds.add(placed.tokenId);
      if (holdingId) {
        for (const [i, entry] of batch.entries.entries()) {
          if (result.entryOutcomes[i] === 'landed') {
            landed.push({
              account: name,
              holdingId,
              row: source.rows[i]!,
              externalId: entry.externalId,
            });
          }
        }
      }
      inserted.push(...result.insertedEntryIds);
      if (
        result.earliestChangedAt &&
        (!earliestChangedAt || result.earliestChangedAt < earliestChangedAt)
      ) {
        earliestChangedAt = result.earliestChangedAt;
      }
      summaries.push({
        name,
        accountId,
        created,
        rowsRead: source.rows.length,
        rowsInserted: result.insertedEntryIds.length,
        rowsUpdated: result.entriesWritten - result.insertedEntryIds.length,
      });
    }

    const { paired, unpaired } = await this.pairTransfers(userId, app, landed, tx);
    await this.categorize(userId, app, landed, tx);
    const summary: BudgetAppImportSummary = {
      app,
      currency: request.currency,
      accounts: summaries,
      transfersPaired: paired,
      transfersUnpaired: unpaired,
      skippedRows: [...request.skippedRows],
      budgetsDropped: true,
    };
    const [record] = await tx
      .insert(schema.budgetAppImports)
      .values({ userId, app, uploadRef: request.uploadRef, createdAccountIds, summary })
      .returning({ id: schema.budgetAppImports.id });
    for (let i = 0; i < inserted.length; i += ENTRY_CHUNK) {
      await tx.insert(schema.budgetAppImportEntries).values(
        inserted.slice(i, i + ENTRY_CHUNK).map((transactionId) => ({
          importId: record!.id,
          transactionId,
        }))
      );
    }
    return {
      importId: record!.id,
      summary,
      holdingIds: [...holdingIds],
      tokenIds: [...tokenIds],
      earliestChangedAt,
    };
  }

  /**
   * Removes the rows this upload inserted, its windows, and every account it
   * created that nothing else writes to now; the engine then rewrites the
   * balances. A transfer one of whose legs goes is unpaired, not deleted.
   * Null when the person has no such upload, or it was undone already.
   */
  async undo(
    userId: string,
    importId: string,
    tx: DatabaseTransaction
  ): Promise<BudgetAppUndoOutcome | null> {
    const t = schema.holdingTransactions;
    const [record] = await tx
      .select()
      .from(schema.budgetAppImports)
      .where(
        and(
          eq(schema.budgetAppImports.id, importId),
          eq(schema.budgetAppImports.userId, userId),
          isNull(schema.budgetAppImports.undoneAt)
        )
      )
      .for('update');
    if (!record) return null;

    const rows = await tx
      .select({
        id: t.id,
        holdingId: t.holdingId,
        occurredAt: t.occurredAt,
        transferGroupId: t.transferGroupId,
      })
      .from(t)
      .innerJoin(
        schema.budgetAppImportEntries,
        eq(schema.budgetAppImportEntries.transactionId, t.id)
      )
      .where(and(eq(schema.budgetAppImportEntries.importId, importId), eq(t.userId, userId)));
    const ids = rows.map((r) => r.id);
    for (const groupId of new Set(
      rows.flatMap((r) => (r.transferGroupId ? [r.transferGroupId] : []))
    )) {
      await this.ledger.releaseTransferGroup(userId, groupId, tx);
    }
    for (let i = 0; i < ids.length; i += ENTRY_CHUNK) {
      await tx.delete(t).where(inArray(t.id, ids.slice(i, i + ENTRY_CHUNK)));
    }
    const holdingIds = [...new Set(rows.map((r) => r.holdingId))];
    await this.coverage.syncTxBoundsFromLedger(holdingIds, tx);

    const inputIds = (await this.inputs.findByUser(userId, tx))
      .filter((input) => input.source === budgetAppSource(record.app as BudgetApp))
      .map((input) => input.id);
    if (inputIds.length > 0) {
      await tx
        .delete(schema.feedInputWindows)
        .where(
          and(
            inArray(schema.feedInputWindows.inputId, inputIds),
            eq(schema.feedInputWindows.uploadRef, record.uploadRef)
          )
        );
    }
    if (holdingIds.length > 0) await this.cacheWriter.refresh(userId, holdingIds, tx);

    let accountsRemoved = 0;
    let accountsKept = 0;
    for (const accountId of record.createdAccountIds) {
      if (await this.accountHoldsEvidence(userId, accountId, tx)) {
        accountsKept++;
        continue;
      }
      const removed = await tx
        .delete(schema.accounts)
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
        .returning({ id: schema.accounts.id });
      accountsRemoved += removed.length;
    }

    await tx
      .update(schema.budgetAppImports)
      .set({ undoneAt: new Date() })
      .where(eq(schema.budgetAppImports.id, importId));
    const earliestChangedAt = rows.reduce<Date | null>(
      (a, r) => (!a || r.occurredAt < a ? r.occurredAt : a),
      null
    );
    return {
      rowsRemoved: ids.length,
      accountsRemoved,
      accountsKept,
      holdingIds,
      earliestChangedAt,
    };
  }

  private async ensureAccount(
    userId: string,
    app: BudgetApp,
    name: string,
    typeCode: string,
    tx: DatabaseTransaction
  ): Promise<{ accountId: string; created: boolean }> {
    const institutionType = await this.institutionTypes.findByCode('other', tx);
    const accountType = await this.accountTypes.findByCode(typeCode, tx);
    if (!institutionType || !accountType) {
      throw new BudgetAppImportRefused('unknown-account-type', typeCode);
    }
    const { institution } = await this.institutions.ensureInstitution(
      { name: APP_NAME[app], typeId: institutionType.id },
      userId,
      tx
    );
    const existing = await this.accounts.findByUserInstitutionName(
      userId,
      institution.id,
      name,
      tx
    );
    if (existing) return { accountId: existing.id, created: false };
    const account = await this.accountService.createAccount(
      { institutionId: institution.id, name, typeId: accountType.id },
      userId,
      tx
    );
    return { accountId: account.id, created: true };
  }

  /**
   * The accounts among these that a provider, a wallet or a live sync feeds.
   * None of them may take an import: its own feed already books the movements.
   */
  async fedAccountIds(
    userId: string,
    accounts: readonly Account[],
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    const ids = accounts.filter((a) => a.userId === userId).map((a) => a.id);
    const fed = new Set<string>();
    if (ids.length === 0) return fed;
    const feeding = (source: string) => {
      const kind = inputSourceClass(source);
      return kind === 'provider' || kind === 'wallet';
    };
    for (const input of await this.inputs.findByUser(userId, tx)) {
      if (ids.includes(input.accountId) && feeding(input.source)) fed.add(input.accountId);
    }
    const facts = await this.inputs.findAccountInputFacts(userId, tx, { accountIds: ids });
    for (const planned of facts.flatMap(planFeedInputs)) {
      if (feeding(planned.source)) fed.add(planned.accountId);
    }
    const syncs = await this.syncOwnership.resolveSyncSources(userId, accounts, tx);
    for (const [accountId, sync] of syncs) if (sync !== null) fed.add(accountId);
    return fed;
  }

  /** The person's accounts, each saying whether it can take an import. */
  async importTargets(userId: string, tx?: DatabaseTransaction): Promise<BudgetAppImportTarget[]> {
    const read = async (t: DatabaseTransaction) => {
      const accounts = await this.accounts.findByUser(userId, t);
      const fed = await this.fedAccountIds(userId, accounts, t);
      return accounts.map((account) => ({
        id: account.id,
        name: account.name,
        typeName: account.typeName,
        eligible: !fed.has(account.id),
      }));
    };
    return tx ? read(tx) : getDb().transaction(read);
  }

  /** The person's uploads, newest first: what the import page lists for undo. */
  async listImports(userId: string, tx?: DatabaseTransaction): Promise<BudgetAppImportRecord[]> {
    const t = schema.budgetAppImports;
    const rows = await (tx ?? getDb())
      .select({
        id: t.id,
        app: t.app,
        summary: t.summary,
        createdAt: t.createdAt,
        undoneAt: t.undoneAt,
      })
      .from(t)
      .where(eq(t.userId, userId))
      .orderBy(desc(t.createdAt))
      .limit(LISTED_IMPORTS);
    return rows.map((row) => ({
      ...row,
      app: row.app as BudgetApp,
      summary: row.summary as BudgetAppImportSummary,
    }));
  }

  /** A provider, a wallet, or a live sync feeds the account: refuse it as a target. */
  private async refuseFedAccounts(
    userId: string,
    chosen: ReadonlyArray<{ name: string; target: BudgetAppAccountTarget }>,
    tx: DatabaseTransaction
  ): Promise<void> {
    const targets = chosen.flatMap(({ name, target }) =>
      target.kind === 'existing' ? [{ name, accountId: target.accountId }] : []
    );
    if (targets.length === 0) return;
    const owned = new Map<string, Account>();
    for (const { name, accountId } of targets) {
      const account = await this.accounts.findByIdAndUser(accountId, userId, tx);
      if (!account) throw new BudgetAppImportRefused('account-not-found', name);
      owned.set(accountId, account);
    }
    const fed = await this.fedAccountIds(userId, [...owned.values()], tx);
    const refused = targets.find((target) => fed.has(target.accountId));
    if (refused) throw new BudgetAppImportRefused('provider-fed', refused.name);
  }

  /**
   * Both sides of a transfer are in the file: the outflow names the account
   * it went to, and that account's inflow names it back, on the same day and
   * for the same amount. Each such pair is one transfer; a side whose other
   * account was not imported stays an ordinary row and enters the queue.
   */
  private async pairTransfers(
    userId: string,
    app: BudgetApp,
    landed: readonly Landed[],
    tx: DatabaseTransaction
  ): Promise<{ paired: number; unpaired: number }> {
    const source = budgetAppSource(app);
    const keyOf = (from: string, to: string, leg: Landed) =>
      [from, to, leg.row.date.toISOString(), leg.row.amount.replace(/^-/, '')].join('\u0000');
    const outflows = new Map<string, Landed[]>();
    for (const leg of landed) {
      if (leg.row.transferAccount && leg.row.amount.startsWith('-')) {
        const key = keyOf(leg.account, leg.row.transferAccount, leg);
        outflows.set(key, [...(outflows.get(key) ?? []), leg]);
      }
    }
    const transferRows = landed.filter((leg) => leg.row.transferAccount !== null).length;
    let paired = 0;
    for (const inflow of landed) {
      if (!inflow.row.transferAccount || inflow.row.amount.startsWith('-')) continue;
      const queue = outflows.get(keyOf(inflow.row.transferAccount, inflow.account, inflow));
      const outflow = queue?.shift();
      if (!outflow) continue;
      const state = await this.pairState(userId, source, outflow, inflow, tx);
      if (state === 'linked') paired++;
      if (state !== 'unlinked') continue;
      await this.links.linkDeclaredPair(
        {
          userId,
          outflow: { holdingId: outflow.holdingId, source, externalId: outflow.externalId },
          inflow: { holdingId: inflow.holdingId, source, externalId: inflow.externalId },
        },
        tx
      );
      paired++;
    }
    return { paired, unpaired: transferRows - paired * 2 };
  }

  /**
   * `linked` when a re-upload finds the pair it linked before: counted, not
   * linked twice. `taken` when another link already holds one leg.
   */
  private async pairState(
    userId: string,
    source: string,
    outflow: Landed,
    inflow: Landed,
    tx: DatabaseTransaction
  ): Promise<'unlinked' | 'linked' | 'taken'> {
    const t = schema.holdingTransactions;
    const rows = await tx
      .select({ group: t.transferGroupId })
      .from(t)
      .where(
        and(
          eq(t.userId, userId),
          eq(t.source, source),
          inArray(t.externalId, [outflow.externalId, inflow.externalId]),
          inArray(t.holdingId, [outflow.holdingId, inflow.holdingId])
        )
      );
    if (rows.length !== 2) return 'taken';
    const [a, b] = rows;
    if (a!.group === null && b!.group === null) return 'unlinked';
    return a!.group !== null && a!.group === b!.group ? 'linked' : 'taken';
  }

  private async categorize(
    userId: string,
    app: BudgetApp,
    landed: readonly Landed[],
    tx: DatabaseTransaction
  ): Promise<void> {
    if (landed.length === 0) return;
    const t = schema.holdingTransactions;
    const key = (holdingId: string, externalId: string) => `${holdingId}\u0000${externalId}`;
    const categoryOf = new Map(
      landed.map((leg) => [key(leg.holdingId, leg.externalId), leg.row.category])
    );
    const rows: { id: string; holdingId: string; externalId: string | null }[] = [];
    for (let i = 0; i < landed.length; i += ENTRY_CHUNK) {
      const chunk = landed.slice(i, i + ENTRY_CHUNK);
      rows.push(
        ...(await tx
          .select({ id: t.id, holdingId: t.holdingId, externalId: t.externalId })
          .from(t)
          .where(
            and(
              eq(t.userId, userId),
              eq(t.source, budgetAppSource(app)),
              inArray(t.holdingId, [...new Set(chunk.map((leg) => leg.holdingId))]),
              inArray(
                t.externalId,
                chunk.map((leg) => leg.externalId)
              )
            )
          ))
      );
    }
    await this.categoryAssigner.assign(
      userId,
      rows.map((row) => ({
        id: row.id,
        category: categoryOf.get(key(row.holdingId, row.externalId ?? '')) ?? null,
      })),
      tx
    );
  }

  private async accountHoldsEvidence(
    userId: string,
    accountId: string,
    tx: DatabaseTransaction
  ): Promise<boolean> {
    const holdings = await tx
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.accountId, accountId), eq(schema.holdings.userId, userId)));
    if (holdings.length === 0) return false;
    const holdingIds = holdings.map((h) => h.id);
    const [entry] = await tx
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(inArray(schema.holdingTransactions.holdingId, holdingIds))
      .limit(1);
    if (entry) return true;
    const [reading] = await tx
      .select({ id: schema.holdingBalanceObservations.id })
      .from(schema.holdingBalanceObservations)
      .where(inArray(schema.holdingBalanceObservations.holdingId, holdingIds))
      .limit(1);
    return reading !== undefined;
  }
}
