import type { DatabaseTransaction } from '@scani/db';
import type { Holding, HoldingTransaction } from '@scani/db/schema';
import type Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { balanceAt } from '../../engine/balance-at';
import type { BalanceAt, BalanceMethod } from '../../engine/types';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { classifyHoldingEvidence } from '../foundation/legacy-classification';

// Pre-loaded per-user data the rollup hands in. A missing key falls through
// to the database, so the non-rollup callers still work.
export interface BalanceAtTimeCaches {
  /**
   * Answers already computed by `balancesFor`, by holding then instant in
   * milliseconds. Read before anything is loaded (A5 D-11).
   */
  balances?: ReadonlyMap<string, ReadonlyMap<number, BalanceAtTimeResult>>;
  /** The full ledger per holding, ascending. Read by P&L, not by the balance. */
  transactions?: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>;
}

export interface BalanceAtTimeResult {
  // The derived balance at `at`. null when nothing the holding records
  // reaches that instant.
  balance: Decimal | null;
  // The reading the engine counted from: the latest at or before `at`, or the
  // first after it when none precedes. null when there is none.
  anchor: 'observation-after' | 'observation-before' | null;
  // The timestamp of the anchor. null when there is none.
  anchorAt: Date | null;
  // `at` precedes the holding's start, so it held nothing we record and the
  // balance is null (SC-252). Callers count the holding as absent.
  beforeRecords: boolean;
}

// How many holdings' whole histories `balancesFor` holds at once. Evidence is
// every row a holding has; one load for a heavy user is the shape that ran
// the worker out of memory (SC-1283).
const EVIDENCE_BATCH = 25;

const ANCHOR_OF = {
  forward: 'observation-before',
  'walk-back': 'observation-after',
  'first-snapshot': 'observation-after',
  'no-anchor': null,
} as const satisfies Record<BalanceMethod, BalanceAtTimeResult['anchor']>;

const UNKNOWN: BalanceAtTimeResult = {
  balance: null,
  anchor: null,
  anchorAt: null,
  beforeRecords: false,
};

function resultOf(answer: BalanceAt): BalanceAtTimeResult {
  if (answer.status === 'absent') return { ...UNKNOWN, beforeRecords: true };
  return {
    balance: answer.balance,
    anchor: ANCHOR_OF[answer.method],
    anchorAt: answer.anchorAt,
    beforeRecords: false,
  };
}

/**
 * A holding's balance at a past instant: the engine's `balanceAt` over the
 * holding's classified evidence (A5 D-6), in the shape history's readers
 * already consume (D-10). Pure read.
 */
@Service()
export class BalanceAtTimeService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly evidenceRepository = Container.get(EngineEvidenceRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly transactionRepository = Container.get(HoldingTransactionRepository);

  async getBalance(
    holdingId: string,
    at: Date,
    tx: DatabaseTransaction | undefined,
    caches: BalanceAtTimeCaches = {}
  ): Promise<BalanceAtTimeResult> {
    const handed = caches.balances?.get(holdingId)?.get(at.getTime());
    if (handed) return handed;
    const holding = await this.holdingRepository.findById(holdingId, tx);
    if (!holding) return UNKNOWN;
    const [raw] = await this.evidenceRepository.findHoldingEvidence(
      { userId: holding.userId, holdingIds: [holdingId] },
      tx
    );
    if (!raw) return UNKNOWN;
    return resultOf(balanceAt(classifyHoldingEvidence(raw).evidence, at));
  }

  /**
   * Every holding's balance at every instant, loading and classifying
   * `EVIDENCE_BATCH` holdings at a time so no more than that many histories
   * are held at once (D-11). A holding gone since it was listed has no entry,
   * and `getBalance` answers it as unknown.
   */
  async balancesFor(
    userId: string,
    holdingIds: readonly string[],
    instants: readonly Date[],
    tx: DatabaseTransaction | undefined
  ): Promise<Map<string, Map<number, BalanceAtTimeResult>>> {
    const answers = new Map<string, Map<number, BalanceAtTimeResult>>();
    for (let i = 0; i < holdingIds.length; i += EVIDENCE_BATCH) {
      const batch = holdingIds.slice(i, i + EVIDENCE_BATCH);
      for (const raw of await this.evidenceRepository.findHoldingEvidence(
        { userId, holdingIds: batch },
        tx
      )) {
        const { evidence } = classifyHoldingEvidence(raw);
        answers.set(
          evidence.holdingId,
          new Map(instants.map((at) => [at.getTime(), resultOf(balanceAt(evidence, at))]))
        );
      }
    }
    return answers;
  }

  // The earliest instant this holding has any evidence for: the first
  // transaction, the first observation, or the moment the holding row
  // itself appeared, whichever is oldest (SC-252).
  //
  // Public because `OpeningBalanceReconciliationService` dates an opening by
  // it and `HistoryRebuildRangeService` sizes a rebuild by it (SC-481,
  // SC-1607). It is not the engine's `startsAt`, which leaves openings and
  // fabricated copies out; moving these callers to it moves those dates, so it
  // waits for its own measurement in A5 PR-10 (D-12).
  //
  // `excludeReconciliationOpening` is what the reconciler passes and nothing
  // else should: its own output is a transaction, so counting it as evidence
  // would place each run's opening 1ms earlier than the last, forever.
  async earliestEvidenceAt(
    holdingId: string,
    holding: Pick<Holding, 'createdAt'> | null,
    tx: DatabaseTransaction | undefined,
    options: { excludeReconciliationOpening?: boolean } = {}
  ): Promise<Date | null> {
    const candidates: Date[] = [];
    if (holding) candidates.push(holding.createdAt);
    const firstTx = await this.transactionRepository.findExtremesForHolding(
      holdingId,
      tx,
      options.excludeReconciliationOpening ? { excludeReconciliationOpening: true } : undefined
    );
    if (firstTx.first) candidates.push(firstTx.first);
    const firstObservation = await this.observationRepository.findExtremesForHolding(holdingId, tx);
    if (firstObservation.first) candidates.push(firstObservation.first);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  }
}
