import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';

/**
 * The `source` of the observation that records a holding's OPENING balance —
 * the figure the row was created with, as opposed to a balance somebody later
 * observed it to have (SC-641).
 *
 * Its own word rather than `sync-capture` for two reasons, and the second is
 * load-bearing:
 *
 * - No sync captured it. The row was created at that figure; calling it a
 *   capture is a claim about where the number came from that is not true.
 * - `holdingIsUntouched` (SC-631) reads an observation on a holding as
 *   evidence a person touched it, and refuses to delete the row if one
 *   exists. An opening observation records nothing beyond the holding's own
 *   existence — the same ground on which `holding_coverage` is excluded — so
 *   it has to be tellable apart from every other observation, by a value
 *   nothing else writes.
 *
 * Nothing in the repo branches on an observation's `source`; it is carried and
 * surfaced. Measured 2026-08-26: the only `=== 'manual'` comparison nearby is
 * on `holdings.source`, not on this column.
 *
 * ## Why this is a declared constant and not the value already lying around
 *
 * The opening already carries `sourceMetadata.origin =
 * 'createHoldingWithEvent'`, and excluding on THAT would have been a one-line
 * diff: no new constant, no signature change, nothing threaded through. It was
 * rejected, and the reason generalises past this file.
 *
 * That option was cheap *because it was incidental*. Nobody chose the string
 * `'createHoldingWithEvent'` as a contract — it is there because the method
 * that first wrote it stamped its own name. Building the exclusion on it would
 * make a later rename silently stop matching, at which point `holdingIsUntouched`
 * answers "touched" for every holding it is asked about and SC-631 deletes
 * nothing, with every test green except the one that checks the money.
 *
 * **A value that is load-bearing at two ends has to be DECLARED load-bearing
 * at both, or the next person to rename something is holding a rule they never
 * agreed to.** Cheapness that comes from reusing something incidental is a
 * loan against a promise nobody made.
 *
 * So: one exported constant, imported by the writers (`writeInflow` and
 * `MirrorLegWriter`, as the opening observation's source) and by the reader
 * (`holding-untouched.ts`). A rename moves both ends together and a typo does
 * not compile.
 */
export const HOLDING_OPEN_OBSERVATION_SOURCE = 'holding-open';

// HoldingService — the two holding writes left outside the feeds writers and
// the holding use cases: a repair script's balance write and the restore of a
// hidden holding. Reads live in HoldingQueryService.
@Service()
export class HoldingService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  // Every balance mutation appends a 'sync-capture' observation, giving
  // the historical-PnL subsystem a forward-history floor for every account
  // whether or not a transaction-ingester is wired for its source.
  //
  // That sentence was false for two years, in exactly one place, and the
  // comment is why nobody looked: `UpdateHoldingUseCase` — the only path a
  // user can edit a MANUAL holding's balance through — wrote the table
  // directly and never reached this service. Measured on production
  // 2026-08-15: zero missing observations across every synced holding,
  // several across the manual ones, and a material amount of unrecorded
  // drift. A clean
  // partition along the one write path that skipped the service (SC-245).
  //
  // That path now records through `SnapshotWriter.record`, and every sync,
  // import and create through the feeds writers (foundation A2), so
  // `recordBalanceObservation` below serves `updateHoldingBalance` only. The
  // invariant is still convention rather than enforcement: nothing stops the
  // next caller writing `holdings` directly.
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);

  constructor() {
    super('HoldingService');
  }

  // Append a sync-capture balance observation.
  //
  // A failure is logged and swallowed here, and that spares the holding
  // mutation only outside a transaction. Inside one it never did: postgres.js
  // `begin()` keeps the scope's first failed query and rethrows it when the
  // scope ends, so the mutation rolls back with the append whatever this
  // catch does (foundation A2 N-3).
  //
  // The dedup key is (holding, observed_at, source); using a fresh Date
  // per call means we rarely collide in practice. On the off-chance of a
  // sub-millisecond collision, the unique constraint turns the second
  // write into a no-op.
  private async recordBalanceObservation(
    holding: { id: string; userId: string; accountId: string; tokenId: string; balance: string },
    transaction: DatabaseTransaction | undefined,
    meta: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.observationRepository.append(
        {
          userId: holding.userId,
          holdingId: holding.id,
          balance: holding.balance,
          observedAt: new Date(),
          source: 'sync-capture',
          sourceMetadata: meta,
        },
        transaction
      );
    } catch (error) {
      this.logger.warn(
        {
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to append sync-capture observation (non-fatal)'
      );
    }
  }

  /** Set a holding's balance and append the `sync-capture` copy of it. */
  async updateHoldingBalance(
    holdingId: string,
    balance: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      await this.holdingRepository.updateBalance(holdingId, balance, transaction);
      // Read back for the owner, account and token the observation is filed under.
      const holding = await this.holdingRepository.findById(holdingId, transaction);
      if (holding) {
        await this.recordBalanceObservation(
          {
            id: holding.id,
            userId: holding.userId,
            accountId: holding.accountId,
            tokenId: holding.tokenId,
            balance,
          },
          transaction,
          { origin: 'updateHoldingBalance' }
        );
      }
    } catch (error) {
      throw this.handleError(error, 'updateHoldingBalance');
    }
  }

  /**
   * Unhide/restore a holding with event tracking
   */
  async unhideHoldingWithEvent(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      await this.holdingRepository.unhideHolding(holdingId, transaction);
      this.logDebug('Holding unhidden', { holdingId });
      return await this.holdingRepository.findById(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'unhideHoldingWithEvent');
    }
  }
}
