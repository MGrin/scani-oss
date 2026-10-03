import { type DatabaseTransaction, getDb } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import {
  EngineShadowReportRepository,
  type RecordShadowRunInput,
  type ShadowRunSummary,
} from '../../repositories/EngineShadowReportRepository';
import {
  addClassifiedCounts,
  type ClassifiedCounts,
  emptyClassifiedCounts,
} from './classified-counts';
import { failureOf } from './failure-message';

/** What one unit of a shadow run found, or the whole run's so far. */
export interface ShadowTally {
  compared: number;
  differences: RecordShadowRunInput['differences'][number][];
  /** What classifying the unit's holdings found; only the balance shadow classifies. */
  classified?: ClassifiedCounts;
}

export interface ShadowRunResult {
  runId: string;
  summary: ShadowRunSummary;
}

interface ShadowRunSpec<U> {
  kind: RecordShadowRunInput['kind'];
  asOf: Date;
  /** The one user a run is narrowed to, which makes its scope `user`. */
  userId: string | undefined;
  /** Whether the summary counts classification: `unlabelled`, `excluded`, `staleLabels`. */
  classifies?: boolean;
  /** The units the run compares one at a time, read in a snapshot once it has started. */
  units: (tx: DatabaseTransaction) => Promise<readonly U[]>;
  /** Names a unit in a failed run's error, as `user <id>`. */
  describe: (unit: U) => string;
  compare: (unit: U, tx: DatabaseTransaction) => Promise<ShadowTally>;
}

/**
 * What every foundation shadow does around its comparisons (D-10): one unit
 * at a time, each in a snapshot of its own, then one report, timed on the
 * wall clock rather than on the instant compared.
 */
@Service()
export class ShadowRunService {
  private readonly reports = Container.get(EngineShadowReportRepository);
  private readonly logger = createComponentLogger('service:ShadowRunService');

  /**
   * Without `tx`, the units are listed, and then each is read, in a read-only
   * REPEATABLE READ transaction of its own, so a unit's evidence is one
   * snapshot. With `tx`, each of those runs in a savepoint and reads at the
   * caller's isolation level: under READ COMMITTED each query takes its own
   * snapshot. A setup or unit that throws ends the run: it is recorded as
   * failed, outside the aborted savepoint or transaction, and the error is
   * rethrown.
   */
  async run<U>(spec: ShadowRunSpec<U>, tx?: DatabaseTransaction): Promise<ShadowRunResult> {
    const startedAt = new Date();
    const tally: ShadowTally = {
      compared: 0,
      differences: [],
      ...(spec.classifies ? { classified: emptyClassifiedCounts() } : {}),
    };

    let units: readonly U[];
    try {
      units = await inSnapshot(tx, spec.units);
    } catch (err) {
      await this.recordFailure(spec, startedAt, tally, tx, 'setup', err);
      throw err;
    }

    for (const unit of units) {
      try {
        // Added only once the unit's snapshot has closed, so a unit that
        // fails part-way leaves nothing half-counted.
        addTally(tally, await inSnapshot(tx, (unitTx) => spec.compare(unit, unitTx)));
      } catch (err) {
        await this.recordFailure(spec, startedAt, tally, tx, spec.describe(unit), err);
        throw err;
      }
    }
    return this.record(spec, startedAt, tally, tx);
  }

  /** Never throws: a failure to record is logged, and the caller rethrows the original error. */
  private async recordFailure<U>(
    spec: ShadowRunSpec<U>,
    startedAt: Date,
    tally: ShadowTally,
    tx: DatabaseTransaction | undefined,
    failed: string,
    err: unknown
  ): Promise<void> {
    this.logger.error(
      { err, kind: spec.kind, unit: failed },
      'shadow failed; the run is recorded as failed'
    );
    await this.record(spec, startedAt, tally, tx, `${failed}: ${failureOf(err)}`).catch(
      (recordErr: unknown) =>
        this.logger.error(
          { err: recordErr, kind: spec.kind },
          'the failed shadow run was not recorded'
        )
    );
  }

  private async record<U>(
    spec: ShadowRunSpec<U>,
    startedAt: Date,
    tally: ShadowTally,
    tx: DatabaseTransaction | undefined,
    error?: string
  ): Promise<ShadowRunResult> {
    const finishedAt = new Date();
    const byCategory: Record<string, number> = {};
    for (const d of tally.differences) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
    const summary: ShadowRunSummary = {
      compared: tally.compared,
      matched: tally.compared - tally.differences.length,
      byCategory,
      ...(tally.classified
        ? {
            unlabelled: { ...tally.classified.unlabelled },
            excluded: { ...tally.classified.excluded },
            staleLabels: tally.classified.staleLabels,
          }
        : {}),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    const runId = await this.reports.recordRun(
      {
        kind: spec.kind,
        scope: spec.userId === undefined ? 'all' : 'user',
        asOf: spec.asOf,
        startedAt,
        finishedAt,
        status: error === undefined ? 'complete' : 'failed',
        summary,
        error,
        differences: tally.differences,
      },
      tx
    );
    return { runId, summary };
  }
}

function inSnapshot<T>(
  tx: DatabaseTransaction | undefined,
  body: (unitTx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  if (tx !== undefined) return tx.transaction(body);
  return getDb().transaction(body, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

function addTally(into: ShadowTally, from: ShadowTally): void {
  into.compared += from.compared;
  // A loop, not a spread: a unit's differences can outnumber the arguments a call takes.
  for (const difference of from.differences) into.differences.push(difference);
  if (into.classified && from.classified) addClassifiedCounts(into.classified, from.classified);
}
