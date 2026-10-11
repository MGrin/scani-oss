import type { DatabaseTransaction } from '@scani/db';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { addClassified, type ClassifiedCounts, emptyClassifiedCounts } from './classified-counts';
import { classifyHoldingEvidence } from './legacy-classification';
import { type ShadowRunResult, ShadowRunService, type ShadowTally } from './ShadowRunService';
import { compareBalance } from './shadow-comparison';

type BalanceTally = ShadowTally & { classified: ClassifiedCounts };

export interface BalanceShadowInput {
  /** The instant compared with each holding's stored balance. */
  asOf: Date;
  userId?: string;
}

/**
 * The nightly balance shadow (D-10): every holding's engine balance beside its
 * stored balance at `asOf`. It writes only its report. It also compared
 * `BalanceAtTimeService` at past instants until A5 PR-2 made that the engine.
 */
@Service()
export class BalanceShadowService {
  private readonly runs = Container.get(ShadowRunService);
  private readonly evidence = Container.get(EngineEvidenceRepository);

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

    tally.compared += 1;
    const difference = compareBalance(holding, input.asOf, {
      balance: raw.holding.balance,
      lastUpdated: raw.holding.lastUpdated,
    });
    if (difference === null) return;
    tally.differences.push({
      ...difference,
      userId,
      holdingId: raw.holding.id,
      tokenId: raw.holding.tokenId,
      baseTokenId: null,
    });
  }
}
