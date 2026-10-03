import { type DatabaseTransaction, getDb } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { FeedInputRepository } from '../../repositories/FeedInputRepository';
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
} from './legacy-classification';
import { type AccountInputFacts, type PlannedFeedInput, planFeedInputs } from './plan-feed-inputs';

/** Every count but `users` and `failedUsers` covers the users that did not fail. */
export interface ClassificationReport {
  apply: boolean;
  /** Users the run covered, failed ones included. */
  users: number;
  /** Inputs the plan names that did not exist yet: what apply creates. */
  inputsPlanned: number;
  /** Inputs persisted: 0 in a dry run. */
  inputsCreated: number;
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

interface Classified {
  raw: LegacyHoldingEvidence;
  holding: ClassifiedHolding;
}

type UserOutcome = Pick<
  ClassificationReport,
  'inputsPlanned' | 'holdings' | 'notes' | 'excluded' | 'inputDedupCollisions' | 'rowsUpdated'
>;

/**
 * The A1 classification backfill: each account's feed inputs, then the
 * classifier's labels written into the columns that are still NULL (D-4).
 * Idempotent: a second run creates no input and updates no row.
 */
@Service()
export class FoundationClassificationService {
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly feedInputs = Container.get(FeedInputRepository);
  private readonly logger = createComponentLogger('service:FoundationClassificationService');

  /**
   * One user at a time, each in its own transaction, a savepoint inside `tx`.
   * A user that throws is rolled back and listed, and the run goes on.
   *
   * A dry run writes nothing and opens no write transaction: an operator
   * script run without --apply gets a read-only session (`@scani/db`'s
   * `read-only.ts`). It classifies against the inputs apply would create,
   * held in memory, and counts the labels apply would write.
   */
  async classify(
    options: { apply: boolean; userId?: string },
    tx?: DatabaseTransaction
  ): Promise<ClassificationReport> {
    const userIds =
      options.userId === undefined
        ? (await this.evidence.findUsersWithHoldings(tx)).map((u) => u.userId)
        : [options.userId];
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

  private backfill(userId: string, tx: DatabaseTransaction | undefined): Promise<UserOutcome> {
    return (tx ?? getDb()).transaction(async (userTx) => {
      const facts = await this.feedInputs.findAccountInputFacts(userId, userTx);
      const inputsPlanned = await this.feedInputs.insertMissing(plannedInputs(facts), userTx);
      // Reloaded after the insert, so every row can name its input.
      const classified = classifyAll(await this.evidence.findHoldingEvidence({ userId }, userTx));
      const rowsUpdated = await this.evidence.fillMissingLabels(
        userId,
        classified.map((c) => c.holding.labels),
        userTx
      );
      return summarise(classified, inputsPlanned, rowsUpdated);
    });
  }

  private preview(userId: string, tx: DatabaseTransaction | undefined): Promise<UserOutcome> {
    // A savepoint inside `tx`, so one user's failed query leaves the others readable.
    if (tx !== undefined) return tx.transaction((readTx) => this.previewIn(userId, readTx));
    return getDb().transaction((readTx) => this.previewIn(userId, readTx), {
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
    return summarise(classified, pending.length, countsOf(classified).unlabelled);
  }
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
  report.holdings.feed += outcome.holdings.feed;
  report.holdings.snapshot += outcome.holdings.snapshot;
  addCounts(report.notes, outcome.notes);
  addCounts(report.excluded, outcome.excluded);
  report.inputDedupCollisions += outcome.inputDedupCollisions;
  addCounts(report.rowsUpdated, outcome.rowsUpdated);
}

function summarise(
  classified: readonly Classified[],
  inputsPlanned: number,
  rowsUpdated: RowCounts
): UserOutcome {
  const outcome: UserOutcome = {
    inputsPlanned,
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
