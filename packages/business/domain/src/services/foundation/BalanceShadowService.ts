import type { DatabaseTransaction } from '@scani/db';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import {
  type BalanceAtTimeResult,
  BalanceAtTimeService,
  type BalanceWalkCaches,
} from '../pricing/BalanceAtTimeService';
import { addClassified, type ClassifiedCounts, emptyClassifiedCounts } from './classified-counts';
import {
  classifyHoldingEvidence,
  type EvidenceHolding,
  type LegacyHoldingEvidence,
} from './legacy-classification';
import { type ShadowRunResult, ShadowRunService, type ShadowTally } from './ShadowRunService';
import { compareBalance, type LegacyBalanceReading } from './shadow-comparison';

type BalanceTally = ShadowTally & { classified: ClassifiedCounts };

export interface BalanceShadowInput {
  /** The instant compared with each holding's stored balance. */
  asOf: Date;
  /** Instants compared with `BalanceAtTimeService`, reading every row the holding has. */
  pastInstants: readonly Date[];
  userId?: string;
}

/**
 * The nightly balance shadow (D-10): every holding's engine balance beside its
 * stored balance at `asOf` and beside `BalanceAtTimeService` at each past
 * instant. It writes only its report.
 */
@Service()
export class BalanceShadowService {
  private readonly runs = Container.get(ShadowRunService);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly balanceAtTime = Container.get(BalanceAtTimeService);

  /** One user at a time, each in a snapshot of its own (`ShadowRunService.run`). */
  run(input: BalanceShadowInput, tx?: DatabaseTransaction): Promise<ShadowRunResult> {
    return this.runs.run(
      {
        kind: 'balance',
        asOf: input.asOf,
        userId: input.userId,
        classifies: true,
        units: async (setupTx) =>
          input.userId === undefined
            ? (await this.evidence.findUsersWithHoldings(setupTx)).map((u) => u.userId)
            : [input.userId],
        describe: (userId) => `user ${userId}`,
        compare: (userId, userTx) => this.compareUser(userId, input, userTx),
      },
      tx
    );
  }

  /**
   * One holding at a time, inside the user's snapshot, so the worker holds one
   * holding's rows rather than a heavy account's whole history.
   */
  private async compareUser(
    userId: string,
    input: BalanceShadowInput,
    tx: DatabaseTransaction
  ): Promise<ShadowTally> {
    const tally: BalanceTally = {
      compared: 0,
      differences: [],
      classified: emptyClassifiedCounts(),
    };
    for (const holdingId of await this.evidence.findHoldingIds(userId, tx)) {
      await this.compareHolding(userId, holdingId, input, tx, tally);
      // Its rows are unreachable once it returns. Collected now, the next
      // holding reuses their memory; left to the collector, several holdings'
      // worth pile up first. Measured over 12 holdings of 10k observations:
      // +88 MB peak RSS with this, +119 MB without.
      Bun.gc(true);
    }
    return tally;
  }

  private async compareHolding(
    userId: string,
    holdingId: string,
    input: BalanceShadowInput,
    tx: DatabaseTransaction,
    tally: BalanceTally
  ): Promise<void> {
    const [raw] = await this.evidence.findHoldingEvidence({ userId, holdingIds: [holdingId] }, tx);
    // Gone since it was listed: possible only at a caller's READ COMMITTED.
    if (raw === undefined) return;
    // The driver's copies of the rows are garbage once read; collected before
    // classifying, their memory is reused rather than added to.
    Bun.gc(true);
    const holding = classifyHoldingEvidence(raw);
    addClassified(tally.classified, holding);
    const caches = cachesOf(raw);

    const readings: Array<{ at: Date; legacy: LegacyBalanceReading }> = [
      { at: input.asOf, legacy: storedReading(raw.holding) },
    ];
    for (const at of input.pastInstants) {
      const result = await this.balanceAtTime.getBalance(raw.holding.id, at, tx, caches);
      readings.push({ at, legacy: historicalReading(result) });
    }

    for (const { at, legacy } of readings) {
      tally.compared += 1;
      const difference = compareBalance(holding, at, legacy);
      if (difference === null) continue;
      tally.differences.push({
        ...difference,
        userId,
        holdingId: raw.holding.id,
        tokenId: raw.holding.tokenId,
        baseTokenId: null,
      });
    }
  }
}

/**
 * The holding's rows already loaded, keyed as `BalanceAtTimeService` reads
 * them, so it answers from the same snapshot the engine does. A holding with
 * no rows gets an empty list rather than none: a missing key falls through to
 * the database.
 */
function cachesOf(raw: LegacyHoldingEvidence): BalanceWalkCaches {
  const id = raw.holding.id;
  return {
    holdings: new Map([[id, raw.holding]]),
    observations: new Map([[id, raw.observations]]),
    transactions: new Map([[id, raw.transactions]]),
  };
}

function storedReading(holding: EvidenceHolding): LegacyBalanceReading {
  return {
    comparator: 'stored-balance',
    balance: holding.balance,
    absent: false,
    interpolated: false,
    floored: false,
    lastUpdated: holding.lastUpdated,
  };
}

/**
 * `beforeRecords` counts as absent: `PortfolioValuationAtTimeService.getPortfolioValue`
 * counts such a holding as absent and values nothing for it.
 */
function historicalReading(r: BalanceAtTimeResult): LegacyBalanceReading {
  return {
    comparator: 'balance-at-time',
    // `toFixed`, as the engine side is written: `toString` turns a dust balance into `1e-8`.
    balance: r.balance?.toFixed() ?? null,
    absent: r.balance === null || r.beforeRecords,
    interpolated: r.interpolated,
    floored: r.floored,
    lastUpdated: null,
  };
}
