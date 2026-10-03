import {
  CREATED_WITH_EVENT_ORIGIN,
  PROVIDER_SYNC_ORIGIN,
  SYNC_CAPTURE_SOURCE,
} from '../../foundation/legacy-ledger-kinds';
import { declareWindow } from '../blocks/window-declarer';
import type {
  AssetRef,
  DecimalString,
  FeedAbsence,
  FeedBatch,
  LegacyBatchOptions,
} from '../feed-batch';

/** One balance the caller kept from a provider's answer, its token already identified. */
export interface LegacySnapshot {
  asset: AssetRef;
  balance: DecimalString;
  capturedAt: Date | undefined;
}

/** What differs between the paths that write balance snapshots. */
export type SnapshotBatchOptions = Pick<
  LegacyBatchOptions,
  | 'holdingMatch'
  | 'holdingPolicy'
  | 'holdingSource'
  | 'arrival'
  | 'holdingFailure'
  | 'absence'
  | 'clearsAbsenceTally'
  | 'unhideOnNonZero'
  | 'unchangedCheckpoint'
  | 'zeroOpensHolding'
>;

/**
 * The instant a balance was true at: the provider's, unless it is unreadable,
 * missing or not before the fetch, and then the fetch, as a source's clock
 * error has always been stamped (SC-1427).
 * A ternary and not `Math.min`, which gives NaN for an unreadable date, so
 * `validateBatch` would refuse the whole run (Task 14 review, C2).
 */
export function snapshotInstant(capturedAt: Date | undefined, fetchedAt: Date): Date {
  return capturedAt !== undefined && capturedAt < fetchedAt ? capturedAt : fetchedAt;
}

/**
 * One provider answer as a feed batch, writing what the balance writers wrote
 * before it moved (D-1): each kept balance a provider checkpoint with today's
 * `sync-capture` provenance, which is also the observation behind the cache,
 * so no copy goes beside it; a holding the batch opens takes the create stamp
 * on its first one. A position the provider reports at zero (an exited one,
 * R62 Q3) is a checkpoint like any other, so it can open a holding where
 * `zeroOpensHolding` lets it. One a probe measured as gone is an absence (Z3,
 * R62 Q3): it zeroes the holding it names and never opens one.
 *
 * The window is what the fetch read: from the earliest instant any returned
 * snapshot was true at, the ones the caller dropped included (`returnedAt`),
 * to the fetch. A fetch that read nothing still read the provider at that
 * instant, and its silence is what an absence zeroes on, so it is a batch,
 * with a window of the fetch alone (this task's rule, of R24(2)'s type).
 */
export function legacySnapshotBatch(input: {
  userId: string;
  input: FeedBatch['input'];
  /** The `capturedAt` of every snapshot the provider returned. */
  returnedAt: ReadonlyArray<Date | undefined>;
  snapshots: readonly LegacySnapshot[];
  absences: readonly FeedAbsence[];
  fetchedAt: Date;
  options: SnapshotBatchOptions;
}): FeedBatch {
  const { fetchedAt, options } = input;
  const read = input.returnedAt.map((at) => snapshotInstant(at, fetchedAt));
  return {
    userId: input.userId,
    input: input.input,
    fetchedAt,
    window: declareWindow({
      shape: 'balance-snapshot',
      capturedAt: read.length > 0 ? read : [fetchedAt],
      fetchedAt,
    }),
    checkpoints: input.snapshots.map((snapshot) => ({
      asset: snapshot.asset,
      at: snapshotInstant(snapshot.capturedAt, fetchedAt),
      amount: snapshot.balance,
      authority: 'provider',
      legacySource: SYNC_CAPTURE_SOURCE,
      legacyMeta: { origin: PROVIDER_SYNC_ORIGIN },
    })),
    entries: [],
    absences: [...input.absences],
    legacy: {
      ...options,
      writesCache: true,
      createdWithoutCheckpoint: 'zero',
      cacheObservation: null,
      derivesTradeLegs: false,
      createdCheckpointMeta: { origin: CREATED_WITH_EVENT_ORIGIN, source: options.holdingSource },
    },
    notices: [],
  };
}
