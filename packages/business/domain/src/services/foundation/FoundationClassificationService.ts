import { type DatabaseTransaction, getDb } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { FeedInputRepository } from '../../repositories/FeedInputRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import {
  addClassified,
  type ClassifiedCounts,
  type Exclusion,
  emptyClassifiedCounts,
  type RowCounts,
} from './classified-counts';
import { failureOf } from './failure-message';
import {
  type ClassifiedHolding,
  classifyHoldingEvidence,
  type EvidenceInput,
  type LegacyHoldingEvidence,
  staleLabelFields,
} from './legacy-classification';
import { mapLegacyEntry } from './legacy-ledger-kinds';
import {
  type AccountInputFacts,
  type PlannedFeedInput,
  planFeedInputs,
  planInputConnections,
} from './plan-feed-inputs';

/** Every count but `users` and `failedUsers` covers the users that did not fail. */
export interface ClassificationReport {
  apply: boolean;
  /** Users the run covered, failed ones included. */
  users: number;
  /** Inputs the plan names that did not exist yet: what apply creates. */
  inputsPlanned: number;
  /** Inputs persisted: 0 in a dry run. */
  inputsCreated: number;
  /**
   * Inputs that existed and were brought up to their account's connection: a
   * missing credential or wallet linked, or the status changed. A dry run
   * counts the inputs apply would bring up.
   */
  inputsLinked: number;
  holdings: { feed: number; snapshot: number };
  /** Summed `ClassifiedHolding.notes`. */
  notes: Record<string, number>;
  excluded: Record<Exclusion, number>;
  /** Entries whose (input_id, external_id) another entry of the same input carries too. */
  inputDedupCollisions: number;
  /** Rows where a label fills a NULL. A dry run counts the labels apply would write. */
  rowsUpdated: RowCounts;
  failedUsers: Array<{ userId: string; error: string }>;
}

/**
 * A ledger label its row has moved away from: one of the rows the
 * `stale-label` note counts, with what dates and explains the move. It
 * carries no quantity and no price.
 */
export interface StaleLabel {
  userId: string;
  entryId: string;
  holdingId: string;
  source: string;
  /** The row's `kind`, which the mapping reads. */
  legacyKind: string;
  /** The `ledger_kind` and `kind_origin` the row carries. */
  storedKind: string | null;
  kindOrigin: string | null;
  /** What the mapping gives the row now: a ledger kind, `excluded:<why>`, or null for none. */
  derivedKind: string | null;
  /** The label fields the mapping no longer gives. */
  differs: string[];
  transferGroupId: string | null;
  updatedAt: Date;
}

export interface StaleLabelList {
  /** Users the run covered, failed ones included. */
  users: number;
  /** The stale labels of the users that did not fail, oldest write first. */
  stale: StaleLabel[];
  failedUsers: Array<{ userId: string; error: string }>;
}

/**
 * The count and both lists cover the users that did not fail. `stale` is the
 * labels stale at the end: in a dry run, the list as read, which apply reads
 * again once it holds the rows.
 */
export interface StaleRelabelReport extends StaleLabelList {
  apply: boolean;
  /** The rows the run re-labelled: `relabelEntries`' own count. 0 in a dry run. */
  relabelled: number;
  /**
   * The stale labels the run handed to the re-label, each as it stood once its
   * row was held: none in a dry run. A label another writer settled while the
   * run waited for its row is not one of them.
   */
  held: StaleLabel[];
}

interface Classified {
  raw: LegacyHoldingEvidence;
  holding: ClassifiedHolding;
}

type UserOutcome = Pick<
  ClassificationReport,
  | 'inputsPlanned'
  | 'inputsLinked'
  | 'holdings'
  | 'notes'
  | 'excluded'
  | 'inputDedupCollisions'
  | 'rowsUpdated'
>;

/**
 * The A1 classification backfill: each account's feed inputs, created where
 * D-7 plans one and brought up to the account's connection where one exists,
 * then the classifier's labels written into the columns that are still NULL
 * (D-4). Idempotent: a second run creates no input and updates no row.
 */
@Service()
export class FoundationClassificationService {
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly feedInputs = Container.get(FeedInputRepository);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly logger = createComponentLogger('service:FoundationClassificationService');

  /**
   * One user at a time, each in its own transaction, a savepoint inside `tx`.
   * A user that throws is rolled back and listed, and the run goes on.
   *
   * A dry run writes nothing and opens no write transaction: an operator
   * script run without --apply gets a read-only session (`@scani/db`'s
   * `read-only.ts`). It classifies against the inputs apply would create,
   * held in memory, and counts the labels and the input links apply would
   * write.
   */
  async classify(
    options: { apply: boolean; userId?: string },
    tx?: DatabaseTransaction
  ): Promise<ClassificationReport> {
    const userIds = await this.usersOf(options.userId, tx);
    const report = emptyReport(options.apply, userIds.length);

    for (const userId of userIds) {
      try {
        const outcome = options.apply
          ? await this.backfill(userId, tx)
          : await this.preview(userId, tx);
        addOutcome(report, outcome);
      } catch (err) {
        this.logger.error({ err, userId }, 'classification failed; the user was rolled back');
        report.failedUsers.push({ userId, error: failureOf(err) });
      }
    }
    return report;
  }

  /**
   * The backfill for these holdings alone, inside the caller's transaction:
   * the classifier's labels over the rows as they stand in `tx`, written where
   * a column is still NULL (D-4). For a writer that puts back rows copied
   * before the labels existed. It creates no input.
   */
  async labelHoldings(
    userId: string,
    holdingIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<RowCounts> {
    const classified = classifyAll(
      await this.evidence.findHoldingEvidence({ userId, holdingIds }, tx)
    );
    return this.evidence.fillMissingLabels(
      userId,
      classified.map((c) => c.holding.labels),
      tx
    );
  }

  /**
   * Every label the dry run's `stale-label` note counts, oldest write first:
   * the same read and the same rule, so the two cannot disagree. It writes
   * nothing, and reads each user in one snapshot as a dry run does. A user
   * whose read throws is listed as failed, and the listing goes on.
   */
  async listStaleLabels(
    options: { userId?: string },
    tx?: DatabaseTransaction
  ): Promise<StaleLabelList> {
    const userIds = await this.usersOf(options.userId, tx);
    const list: StaleLabelList = { users: userIds.length, stale: [], failedUsers: [] };
    for (const userId of userIds) {
      try {
        list.stale.push(
          ...(await this.reading(tx, (readTx) => this.staleLabelsOf(userId, readTx)))
        );
      } catch (err) {
        this.logger.error({ err, userId }, 'listing stale labels failed; the user is not listed');
        list.failedUsers.push({ userId, error: failureOf(err) });
      }
    }
    list.stale.sort(oldestWriteFirst);
    return list;
  }

  /**
   * Re-labels every row `listStaleLabels` lists, through `relabelEntries`: the
   * D-5 overwrite of a label by the mapping of its row as stored, which leaves
   * a decision and a rule, mirror or Jev label alone. One user at a time, each
   * in its own transaction, a savepoint inside `tx`, which takes the rows it
   * lists and lists them again before it re-labels them; a user that throws,
   * or waits 5s behind a writer that keeps one of its rows, is rolled back and
   * listed, and the run goes on. A second run finds nothing.
   *
   * A dry run writes nothing: it is `listStaleLabels`, the labels stale as
   * read. Apply writes the ones still stale once it holds their rows.
   */
  async relabelStaleLabels(
    options: { apply: boolean; userId?: string },
    tx?: DatabaseTransaction
  ): Promise<StaleRelabelReport> {
    if (!options.apply) {
      return {
        apply: false,
        relabelled: 0,
        held: [],
        ...(await this.listStaleLabels(options, tx)),
      };
    }
    const userIds = await this.usersOf(options.userId, tx);
    const report: StaleRelabelReport = {
      apply: true,
      users: userIds.length,
      relabelled: 0,
      held: [],
      stale: [],
      failedUsers: [],
    };
    for (const userId of userIds) {
      try {
        const outcome = await this.relabelStaleOf(userId, tx);
        report.relabelled += outcome.relabelled;
        report.held.push(...outcome.held);
        report.stale.push(...outcome.stale);
      } catch (err) {
        this.logger.error({ err, userId }, 're-labelling failed; the user was rolled back');
        report.failedUsers.push({ userId, error: failureOf(err) });
      }
    }
    report.held.sort(oldestWriteFirst);
    report.stale.sort(oldestWriteFirst);
    return report;
  }

  private relabelStaleOf(
    userId: string,
    tx: DatabaseTransaction | undefined
  ): Promise<Pick<StaleRelabelReport, 'relabelled' | 'held' | 'stale'>> {
    return (tx ?? getDb()).transaction(async (userTx) => {
      await boundLockWait(userTx);
      const found = await this.staleLabelsOf(userId, userTx);
      if (found.length === 0) return { relabelled: 0, held: [], stale: [] };
      // The pass wrote none of these rows, so it takes them before the re-label reads them.
      const taken = new Set(found.map((label) => label.entryId));
      await this.ledger.lockInIdOrder(userId, [...taken], userTx);
      // Listed again now that the rows are held: a writer the lock waited on
      // may have settled a label, or changed what it differs in. A label that
      // went stale meanwhile is on a row this did not take, so it is left.
      const held = (await this.staleLabelsOf(userId, userTx)).filter((label) =>
        taken.has(label.entryId)
      );
      const relabelled = await this.ledger.relabelEntries(
        userId,
        held.map((label) => label.entryId),
        userTx
      );
      return { relabelled, held, stale: await this.staleLabelsOf(userId, userTx) };
    });
  }

  /** The one user named, or every user with a holding. */
  private async usersOf(
    userId: string | undefined,
    tx: DatabaseTransaction | undefined
  ): Promise<string[]> {
    if (userId !== undefined) return [userId];
    return (await this.evidence.findUsersWithHoldings(tx)).map((u) => u.userId);
  }

  private async staleLabelsOf(userId: string, tx: DatabaseTransaction): Promise<StaleLabel[]> {
    const raws = await this.evidence.findHoldingEvidence({ userId }, tx);
    const stale = raws.flatMap((raw) =>
      raw.transactions.flatMap((row) => {
        const mapping = mapLegacyEntry(row);
        const differs = staleLabelFields(row, mapping);
        return differs.length === 0 ? [] : [{ row, mapping, differs }];
      })
    );
    const updatedAt = await this.evidence.findEntryUpdatedAt(
      userId,
      stale.map(({ row }) => row.id),
      tx
    );
    return stale.map(({ row, mapping, differs }) => {
      const writtenAt = updatedAt.get(row.id);
      if (writtenAt === undefined) throw new Error(`ledger row ${row.id} left its own snapshot`);
      return {
        userId,
        entryId: row.id,
        holdingId: row.holdingId,
        source: row.source,
        legacyKind: row.kind,
        storedKind: row.ledgerKind,
        kindOrigin: row.kindOrigin,
        derivedKind:
          mapping.excluded === null ? mapping.ledgerKind : `excluded:${mapping.excluded}`,
        differs,
        transferGroupId: row.transferGroupId,
        updatedAt: writtenAt,
      };
    });
  }

  private backfill(userId: string, tx: DatabaseTransaction | undefined): Promise<UserOutcome> {
    return (tx ?? getDb()).transaction(async (userTx) => {
      await boundLockWait(userTx);
      const facts = await this.feedInputs.findAccountInputFacts(userId, userTx);
      const inputsPlanned = await this.feedInputs.insertMissing(plannedInputs(facts), userTx);
      // An input ingest created starts active and names no credential or
      // wallet, and stays so until its account's next connect, disconnect or
      // import (R94). Linked here by the follower's own rule, and before any
      // label is written: an ingest takes its input's row first and its
      // holdings' after, so this takes them in that order too.
      const inputsLinked = await this.feedInputs.linkAndSetStatus(
        facts.flatMap(planInputConnections),
        userTx
      );
      // Reloaded after the insert, so every row can name its input.
      const classified = classifyAll(await this.evidence.findHoldingEvidence({ userId }, userTx));
      const rowsUpdated = await this.evidence.fillMissingLabels(
        userId,
        classified.map((c) => c.holding.labels),
        userTx
      );
      return summarise(classified, { inputsPlanned, inputsLinked }, rowsUpdated);
    });
  }

  private preview(userId: string, tx: DatabaseTransaction | undefined): Promise<UserOutcome> {
    return this.reading(tx, (readTx) => this.previewIn(userId, readTx));
  }

  /** One user's rows, read in one read-only snapshot. */
  private reading<T>(
    tx: DatabaseTransaction | undefined,
    read: (readTx: DatabaseTransaction) => Promise<T>
  ): Promise<T> {
    // A savepoint inside `tx`, so one user's failed query leaves the others readable.
    if (tx !== undefined) return tx.transaction(read);
    return getDb().transaction(read, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  private async previewIn(userId: string, tx: DatabaseTransaction): Promise<UserOutcome> {
    const facts = await this.feedInputs.findAccountInputFacts(userId, tx);
    const existing = await this.feedInputs.findByUser(userId, tx);
    const pending = plannedInputs(facts)
      .filter((p) => !existing.some((e) => e.accountId === p.accountId && e.source === p.source))
      .map(pendingInput);
    const classified = classifyAll(
      (await this.evidence.findHoldingEvidence({ userId }, tx)).map((raw) => ({
        ...raw,
        inputs: [...raw.inputs, ...pending.filter((i) => i.accountId === raw.holding.accountId)],
      }))
    );
    const inputsLinked = await this.feedInputs.countBehindTheirPlan(
      facts.flatMap(planInputConnections),
      tx
    );
    return summarise(
      classified,
      { inputsPlanned: pending.length, inputsLinked },
      countsOf(classified).unlabelled
    );
  }
}

/**
 * A user's transaction gives the user up 5s behind a lock, the foundation
 * migrations' bound, rather than hold whatever it already took until the
 * session's statement timeout. The apply holds its inputs' rows across every
 * account, which an ingest takes one at a time and a multi-account import in
 * its own order; the relabel pass holds the ledger rows it lists. The user is
 * rolled back and listed, and a re-run is idempotent.
 *
 * `SET LOCAL` lasts to the end of the outermost transaction. A caller that
 * passes its own `tx` keeps the 5s bound for whatever it writes afterwards.
 */
function boundLockWait(tx: DatabaseTransaction) {
  return tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
}

function oldestWriteFirst(a: StaleLabel, b: StaleLabel): number {
  return a.updatedAt.getTime() - b.updatedAt.getTime() || (a.entryId < b.entryId ? -1 : 1);
}

function plannedInputs(facts: readonly AccountInputFacts[]): PlannedFeedInput[] {
  return facts.flatMap((f) => planFeedInputs(f));
}

/** An input apply would create, under an id no stored input can have. */
function pendingInput(planned: PlannedFeedInput): EvidenceInput {
  return {
    id: `planned:${planned.accountId}:${planned.source}`,
    accountId: planned.accountId,
    source: planned.source,
  };
}

function classifyAll(raws: readonly LegacyHoldingEvidence[]): Classified[] {
  return raws.map((raw) => ({ raw, holding: classifyHoldingEvidence(raw) }));
}

function countsOf(classified: readonly Classified[]): ClassifiedCounts {
  const counts = emptyClassifiedCounts();
  for (const { holding } of classified) addClassified(counts, holding);
  return counts;
}

function emptyReport(apply: boolean, users: number): ClassificationReport {
  return {
    apply,
    users,
    inputsPlanned: 0,
    inputsCreated: 0,
    inputsLinked: 0,
    holdings: { feed: 0, snapshot: 0 },
    notes: {},
    excluded: emptyClassifiedCounts().excluded,
    inputDedupCollisions: 0,
    rowsUpdated: { holdings: 0, observations: 0, entries: 0 },
    failedUsers: [],
  };
}

function addOutcome(report: ClassificationReport, outcome: UserOutcome): void {
  report.inputsPlanned += outcome.inputsPlanned;
  if (report.apply) report.inputsCreated += outcome.inputsPlanned;
  report.inputsLinked += outcome.inputsLinked;
  report.holdings.feed += outcome.holdings.feed;
  report.holdings.snapshot += outcome.holdings.snapshot;
  addCounts(report.notes, outcome.notes);
  addCounts(report.excluded, outcome.excluded);
  report.inputDedupCollisions += outcome.inputDedupCollisions;
  addCounts(report.rowsUpdated, outcome.rowsUpdated);
}

function summarise(
  classified: readonly Classified[],
  inputs: Pick<UserOutcome, 'inputsPlanned' | 'inputsLinked'>,
  rowsUpdated: RowCounts
): UserOutcome {
  const outcome: UserOutcome = {
    ...inputs,
    holdings: { feed: 0, snapshot: 0 },
    notes: {},
    excluded: countsOf(classified).excluded,
    inputDedupCollisions: dedupCollisions(classified),
    rowsUpdated,
  };
  for (const { holding } of classified) {
    outcome.holdings[holding.evidence.kind] += 1;
    addCounts(outcome.notes, holding.notes);
  }
  return outcome;
}

/**
 * Entries that would break A2's unique (input_id, external_id): every entry
 * whose key another entry of the same input carries, so a colliding pair is 2.
 * An input belongs to one account, so one user's entries are all it can meet.
 */
function dedupCollisions(classified: readonly Classified[]): number {
  const sharing = new Map<string, number>();
  for (const { raw, holding } of classified) {
    const externalIdOf = new Map(raw.transactions.map((t) => [t.id, t.externalId]));
    for (const entry of holding.evidence.entries) {
      const externalId = externalIdOf.get(entry.id);
      if (entry.inputId === null || externalId === undefined) continue;
      const key = JSON.stringify([entry.inputId, externalId]);
      sharing.set(key, (sharing.get(key) ?? 0) + 1);
    }
  }
  let colliding = 0;
  for (const entries of sharing.values()) {
    if (entries > 1) colliding += entries;
  }
  return colliding;
}

function addCounts<K extends string>(into: Record<K, number>, from: Readonly<Record<K, number>>) {
  for (const key of Object.keys(from) as K[]) {
    into[key] = (into[key] ?? 0) + from[key];
  }
}
