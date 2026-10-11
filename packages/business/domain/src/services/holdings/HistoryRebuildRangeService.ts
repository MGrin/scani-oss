import type { DatabaseTransaction } from '@scani/db';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BalanceAtTimeService } from '../pricing/BalanceAtTimeService';

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The earliest UTC day an edit can move in a user's stored history, so the
 * rebuild it triggers starts there instead of at the user's first record
 * (SC-1607). `undefined` means "rebuild the whole window": the answer whenever
 * a holding cannot be read, because a start too late is a wrong chart and a
 * start too early is only a slower one.
 *
 * Changes the rebuild job makes itself — a moved opening, a new transfer
 * link, a price written further back — are widened by the job, not here.
 */
@Service()
export class HistoryRebuildRangeService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly balanceAtTime = Container.get(BalanceAtTimeService);

  /**
   * A change dated `at` on these holdings: a balance edit, a movement, money
   * in or out. A day's balance interpolates between the observations either
   * side of it, so the change reaches back to the observation before `at`;
   * with none before it, the projection from the first record moves. A
   * holding that has gone below zero is moved whole, because its floor is the
   * lowest balance it ever had and every day reads it.
   */
  async fromEdit(
    holdingIds: readonly string[],
    at: Date,
    tx?: DatabaseTransaction
  ): Promise<string | undefined> {
    let earliest = at;
    for (const holdingId of holdingIds) {
      const holding = await this.holdingRepository.findById(holdingId, tx);
      if (!holding) return undefined;
      const before = (await this.floorBelowZero(holding, tx))
        ? null
        : await this.observationRepository.findLatestAtOrBefore(holdingId, at, tx);
      const from = before
        ? before.observedAt
        : await this.balanceAtTime.earliestEvidenceAt(holdingId, holding, tx);
      if (!from) return undefined;
      if (from < earliest) earliest = from;
    }
    return utcDay(earliest);
  }

  /**
   * Read BEFORE an edit that changes a balance: the earliest record of any of
   * these holdings whose floor is below zero, or null when none is. The floor
   * is min(0, lowest observation, balance), so an edit that raises a negative
   * balance with no negative observation behind it lifts the floor to 0 and
   * moves every day; read after the write, the floor is already 0 (feeds,
   * #22804).
   */
  async fromFloor(
    holdingIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<string | null | undefined> {
    const below: string[] = [];
    for (const holdingId of holdingIds) {
      const holding = await this.holdingRepository.findById(holdingId, tx);
      if (!holding) return undefined;
      if (await this.floorBelowZero(holding, tx)) below.push(holdingId);
    }
    return below.length === 0 ? null : this.fromWholeHoldings(below, tx);
  }

  /** `fromFloor` for a gap answer: the gap's holding and the arrival's, read before the answer. */
  async fromFloorAtObservation(
    observationId: string,
    destinationHoldingId: string | null,
    tx?: DatabaseTransaction
  ): Promise<string | null | undefined> {
    const closing = await this.observationRepository.findById(observationId, tx);
    if (!closing) return undefined;
    return this.fromFloor(
      destinationHoldingId ? [closing.holdingId, destinationHoldingId] : [closing.holdingId],
      tx
    );
  }

  private async floorBelowZero(
    holding: { id: string; balance: string },
    tx: DatabaseTransaction | undefined
  ): Promise<boolean> {
    const lowest = await this.observationRepository.findLowestBalance(holding.id, tx);
    return Decimal.min(lowest ?? 0, holding.balance).lt(0);
  }

  /**
   * A change to the whole of each holding: hidden or shown, deleted, a scam
   * verdict. Every day from its earliest record moves. Read it BEFORE a hard
   * delete, which removes the records it is read from.
   */
  async fromWholeHoldings(
    holdingIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<string | undefined> {
    let earliest = new Date();
    for (const holdingId of holdingIds) {
      const holding = await this.holdingRepository.findById(holdingId, tx);
      if (!holding) return undefined;
      const from = await this.balanceAtTime.earliestEvidenceAt(holdingId, holding, tx);
      if (!from) return undefined;
      if (from < earliest) earliest = from;
    }
    return utcDay(earliest);
  }

  /** Every holding in these accounts, whole. Read before the delete cascades them away. */
  async fromAccounts(
    userId: string,
    accountIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<string | undefined> {
    const holdingIds: string[] = [];
    for (const accountId of accountIds) {
      holdingIds.push(...(await this.holdingRepository.findIdsForUser(userId, { accountId }, tx)));
    }
    return this.fromWholeHoldings(holdingIds, tx);
  }

  /** A scam verdict moves every holding of the token, hidden ones included, whole. */
  async fromTokenHoldings(
    userId: string,
    tokenId: string,
    tx?: DatabaseTransaction
  ): Promise<string | undefined> {
    const holdingIds = await this.holdingRepository.findIdsForUser(userId, { tokenId }, tx);
    return this.fromWholeHoldings(holdingIds, tx);
  }

  /**
   * An answer to the gap that ends at this observation. Its rows sit inside
   * the gap, so the gap's holding moves from the observation that opens it.
   * An arrival it writes on another holding is dated inside the gap too, so
   * that holding moves from its own observation before the gap opened; with
   * no observation opening the gap, the arrival's date is unbounded and that
   * holding moves whole.
   */
  async fromGapAnswer(
    observationId: string,
    destinationHoldingId: string | null,
    tx?: DatabaseTransaction
  ): Promise<string | undefined> {
    const closing = await this.observationRepository.findById(observationId, tx);
    if (!closing) return undefined;
    const opening = await this.observationRepository.findLatestAtOrBefore(
      closing.holdingId,
      new Date(closing.observedAt.getTime() - 1),
      tx
    );
    const ids = destinationHoldingId
      ? [closing.holdingId, destinationHoldingId]
      : [closing.holdingId];
    return opening ? this.fromEdit(ids, opening.observedAt, tx) : this.fromWholeHoldings(ids, tx);
  }
}
