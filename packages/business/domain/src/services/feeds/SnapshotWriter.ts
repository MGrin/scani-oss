import type { DatabaseTransaction } from '@scani/db';
import type { Holding, NewHoldingTransaction } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import type { ObservationRole, SnapshotCause } from '../../engine/types';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { classifyHoldingEvidence, personValueRole } from '../foundation/legacy-classification';
import { ObservationLabeller } from '../foundation/ObservationLabeller';
import { type CacheWrite, HoldingCacheWriter } from './HoldingCacheWriter';
import type { IngestOutcome } from './ingest-outcome';

export interface SnapshotEntry {
  externalId: string;
  /** Signed quantity, `toFixed()`. */
  amount: string;
  occurredAt: Date;
  legacy: Pick<NewHoldingTransaction, 'kind' | 'source' | 'sourceMetadata'>;
}

/**
 * The person said what this balance change was, at the moment they made it
 * (SC-606).
 *
 * Stamped into the observation's OWN insert rather than updated onto it a
 * moment later, so there is never an instant where the row exists unanswered:
 * `BalanceGapService.listPending` is computed on read, and a queue read
 * landing in that window would show a gap the user has already explained.
 *
 * The value is a `BalanceGapAnswer` — the same vocabulary the queue writes,
 * because SC-501 already made `BALANCE_GAP_ANSWERS` `MANUAL_EDIT_CAUSES` plus
 * `unknown` precisely so the two paths could not drift. `gapReviewSource` is
 * always `'user'`: nothing else may claim this, since the whole content of the
 * marker is that a person was present and spoke.
 */
interface BalanceObservationAttestation {
  /** What they said it was. A `BalanceGapAnswer`, not a free string. */
  answer: string;
  /** When they said it. Defaults to the observation's own instant. */
  at?: Date;
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
  private readonly labeller = Container.get(ObservationLabeller);
  private readonly evidence = Container.get(EngineEvidenceRepository);

  /**
   * One observation, authority `person` and no input, its role by Rule P and
   * NULL while the holding's kind is (D-6): a snapshot until the holding's feed
   * has produced evidence, a verification from then on (D7). A snapshot at the
   * instant of live person snapshots replaces them and stays a correction if
   * one was; otherwise a snapshot that is a correction replaces the latest live
   * snapshot before it. A verification, or a value with no role, replaces
   * nothing.
   *
   * A value whose (instant, source) is already taken is not recorded, as the
   * path it replaces dropped it, and nothing is superseded for it; the cache is
   * still set and the outcome says so. Any other failure throws.
   *
   * A snapshot recorded with no cause takes the one A1's classifier derives,
   * so it carries the label the backfill would give it (R74).
   */
  async record(
    value: SnapshotValue,
    options: { cache: 'set' | 'unchanged' },
    tx: DatabaseTransaction
  ): Promise<IngestOutcome> {
    const { userId, holdingId, amount } = value;
    const holding = await this.ownedHolding(userId, holdingId, 'no key update', tx);
    const now = new Date();
    const at = value.at.getTime() < now.getTime() ? value.at : now;

    const role =
      holding.kind === null ? null : await this.personValueRoleAt(userId, holdingId, at, tx);

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
    // Last, so the classifier reads every row this call wrote. A verification
    // or a value with no role keeps the cause it was given (Task 4).
    if (recorded !== null && role === 'snapshot' && cause === null) {
      await this.labeller.labelAsClassified(userId, holdingId, recorded.id, tx);
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
   * It writes no observation: a movement is not a reading of the balance.
   * Copies written before A5 are SC-1634's to delete (R11).
   */
  async recordEntries(
    input: {
      userId: string;
      holdingId: string;
      entries: readonly SnapshotEntry[];
      cache: CacheWrite | null;
    },
    tx: DatabaseTransaction
  ): Promise<IngestOutcome> {
    const { userId, holdingId, entries, cache } = input;
    // The level the upsert below takes on the holding, so its lock is not an
    // upgrade (R81). With no entries it upserts, and locks, nothing.
    const holding = await this.ownedHolding(
      userId,
      holdingId,
      entries.length > 0 ? 'update' : 'no key update',
      tx
    );
    // A balance for a holding whose ledger this call did not move would be a
    // figure today's path never wrote (D-1).
    if (cache && cache.holdingId !== holdingId) {
      throw new Error(
        `SnapshotWriter: a cache write for holding ${cache.holdingId} cannot ride on entries for ${holdingId}`
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

    return {
      userId,
      touchedHoldingIds: [holdingId],
      createdHoldingIds: [],
      earliestChangedAt,
      notices: [],
    };
  }

  /**
   * Rule P itself, on the kind and `feedBeganAt` the classifier derives from
   * the holding's rows as they stand in `tx`, read as the backfill reads them
   * (`findHoldingEvidence`): so the role written is the one O2 gives the row
   * (R85). Read after the row lock, and taking none. The value being written
   * is a person's, so it moves neither the kind nor `feedBeganAt`, and as a
   * new row it has no persisted role.
   */
  private async personValueRoleAt(
    userId: string,
    holdingId: string,
    at: Date,
    tx: DatabaseTransaction
  ): Promise<ObservationRole> {
    const [raw] = await this.evidence.findHoldingEvidence({ userId, holdingIds: [holdingId] }, tx);
    if (raw === undefined) {
      throw new Error(`SnapshotWriter: user ${userId} has no holding ${holdingId}`);
    }
    const { evidence, feedBeganAt } = classifyHoldingEvidence(raw);
    return personValueRole(null, evidence.kind, at, feedBeganAt);
  }

  /**
   * The holding, its row locked before anything is read, so two writers of one
   * holding take turns and the second reads what the first committed (R72,
   * R75). A caller that already holds the row at this level waits on nothing
   * here.
   */
  private async ownedHolding(
    userId: string,
    holdingId: string,
    level: 'no key update' | 'update',
    tx: DatabaseTransaction
  ): Promise<Holding> {
    const holding = await this.holdingRepository.lockOwned(userId, holdingId, level, tx);
    if (!holding) {
      throw new Error(`SnapshotWriter: user ${userId} has no holding ${holdingId}`);
    }
    return holding;
  }
}
