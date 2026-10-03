import type { DatabaseTransaction } from '@scani/db';
import type { Holding, NewHoldingTransaction } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import type { ObservationRole, SnapshotCause } from '../../engine/types';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import type { BalanceObservationAttestation } from '../holdings/HoldingService';
import { type CacheWrite, HoldingCacheWriter } from './HoldingCacheWriter';
import type { IngestOutcome } from './ingest-outcome';

export interface SnapshotEntry {
  externalId: string;
  /** Signed quantity, `toFixed()`. */
  amount: string;
  occurredAt: Date;
  legacy: Pick<NewHoldingTransaction, 'kind' | 'source' | 'sourceMetadata'>;
}

export interface SnapshotValue {
  userId: string;
  holdingId: string;
  amount: string;
  /** A future or unreadable instant is a clock error and becomes now, as it always has. */
  at: Date;
  cause: SnapshotCause | null;
  /** Today's observation `source`, which readers still key on (D-5). */
  legacySource: string;
  /** Today's `source_metadata`, its `origin` included. */
  legacyMeta: Record<string, unknown>;
  attestation?: BalanceObservationAttestation;
}

/** The copy of the new balance a replaced path wrote as an observation. */
interface LegacyObservation {
  source: string;
  sourceMetadata: Record<string, unknown>;
}

/** D-6: what a person's value is evidence of follows the holding's kind. */
const PERSON_VALUE_ROLE: Record<NonNullable<Holding['kind']>, ObservationRole> = {
  snapshot: 'snapshot',
  feed: 'verification',
};

/**
 * The A2 writer for what a person typed, or configured: a value on a holding,
 * or movements on a snapshot holding.
 */
@Service()
export class SnapshotWriter {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);

  /**
   * One observation, authority `person` and no input, its role by the holding's
   * kind and NULL while the kind is (D-6). A snapshot at the instant of live
   * person snapshots replaces them and stays a correction if one was; otherwise
   * a snapshot that is a correction replaces the latest live snapshot before it.
   * A verification, or a value with no role, replaces nothing.
   *
   * A value whose (instant, source) is already taken is not recorded, as the
   * path it replaces dropped it, and nothing is superseded for it; the cache is
   * still set and the outcome says so. Any other failure throws.
   */
  async record(
    value: SnapshotValue,
    options: { cache: 'set' | 'unchanged' },
    tx: DatabaseTransaction
  ): Promise<IngestOutcome> {
    const { userId, holdingId, amount } = value;
    const holding = await this.ownedHolding(userId, holdingId, tx);
    const now = new Date();
    const at = value.at.getTime() < now.getTime() ? value.at : now;

    const role = holding.kind === null ? null : PERSON_VALUE_ROLE[holding.kind];

    // Only a snapshot replaces another. A verification never anchors, so one
    // that superseded a snapshot would remove an anchor and leave nothing.
    const replaces = role === 'snapshot';
    const sameInstant = replaces
      ? await this.observations.findLivePersonSnapshotsAt(userId, holdingId, at, tx)
      : [];
    const corrected =
      replaces && sameInstant.length === 0 && value.cause === 'correction'
        ? await this.observations.findLatestLiveSnapshotAtOrBefore(userId, holdingId, at, tx)
        : null;
    const cause = sameInstant.some((o) => o.cause === 'correction') ? 'correction' : value.cause;

    const recorded = await this.observations.append(
      {
        userId,
        holdingId,
        balance: amount,
        observedAt: at,
        source: value.legacySource,
        sourceMetadata: value.legacyMeta,
        role,
        authority: 'person',
        inputId: null,
        cause,
        ...(value.attestation
          ? {
              gapReview: value.attestation.answer,
              gapReviewSource: 'user',
              gapReviewedAt: value.attestation.at ?? now,
            }
          : {}),
      },
      tx
    );
    if (recorded !== null) {
      await this.observations.supersede(
        userId,
        [...sameInstant.map((o) => o.id), ...(corrected ? [corrected.id] : [])],
        tx
      );
    }

    await this.holdingRepository.lowerStartsAt(userId, holdingId, at, tx);
    if (options.cache === 'set') {
      await this.cacheWriter.apply(userId, [{ holdingId, balance: amount }], tx);
    }

    return {
      userId,
      touchedHoldingIds: [holdingId],
      createdHoldingIds: [],
      earliestChangedAt: recorded === null ? null : (corrected?.observedAt ?? at),
      notices:
        recorded === null
          ? [
              `holding ${holdingId} already has a ${value.legacySource} observation at ${at.toISOString()}; the value ${amount} was not recorded`,
            ]
          : [],
    };
  }

  /**
   * It writes no evidence observation: a movement is not a reading of the
   * balance. `legacyObservation` is appended unlabelled, at the balance the
   * cache write sets. Legacy history spreads unexplained drift from the nearest
   * observation, so the anchor stays until A5; the engine excludes it (R11).
   */
  async recordEntries(
    input: {
      userId: string;
      holdingId: string;
      entries: readonly SnapshotEntry[];
      cache: CacheWrite | null;
      legacyObservation?: LegacyObservation;
    },
    tx: DatabaseTransaction
  ): Promise<IngestOutcome> {
    const { userId, holdingId, entries, cache, legacyObservation } = input;
    const holding = await this.ownedHolding(userId, holdingId, tx);
    // A balance for a holding whose ledger this call did not move would be a
    // figure today's path never wrote (D-1).
    if (cache && cache.holdingId !== holdingId) {
      throw new Error(
        `SnapshotWriter: a cache write for holding ${cache.holdingId} cannot ride on entries for ${holdingId}`
      );
    }

    if (legacyObservation && !cache) {
      throw new Error(
        `SnapshotWriter: a legacy observation for holding ${holdingId} needs the cache write whose balance it reads`
      );
    }

    // Labelled by the upsert itself, and person rows carry no input (D-5).
    const { earliestChangedAt } = await this.ledger.bulkUpsert(
      entries.map((entry) => ({
        userId,
        holdingId,
        tokenId: holding.tokenId,
        kind: entry.legacy.kind,
        quantity: entry.amount,
        occurredAt: entry.occurredAt,
        externalId: entry.externalId,
        source: entry.legacy.source,
        sourceMetadata: entry.legacy.sourceMetadata,
        inputId: null,
      })),
      tx
    );

    const earliest = entries.reduce<Date | null>(
      (min, entry) => (min === null || entry.occurredAt < min ? entry.occurredAt : min),
      null
    );
    if (earliest) await this.holdingRepository.lowerStartsAt(userId, holdingId, earliest, tx);
    if (cache) await this.cacheWriter.apply(userId, [cache], tx);
    if (cache && legacyObservation) {
      await this.observations.append(
        {
          userId,
          holdingId,
          balance: cache.balance,
          observedAt: new Date(),
          source: legacyObservation.source,
          sourceMetadata: legacyObservation.sourceMetadata,
        },
        tx
      );
    }

    return {
      userId,
      touchedHoldingIds: [holdingId],
      createdHoldingIds: [],
      earliestChangedAt,
      notices: [],
    };
  }

  private async ownedHolding(
    userId: string,
    holdingId: string,
    tx: DatabaseTransaction
  ): Promise<Holding> {
    const holding = await this.holdingRepository.findById(holdingId, tx);
    if (!holding || holding.userId !== userId) {
      throw new Error(`SnapshotWriter: user ${userId} has no holding ${holdingId}`);
    }
    return holding;
  }
}
