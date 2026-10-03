import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { HoldingKind } from '../engine/types';
import {
  BalanceSyncOwnershipService,
  type SyncOwnableAccount,
} from './accounts/BalanceSyncOwnershipService';
import { HoldingCacheWriter } from './feeds/HoldingCacheWriter';
import { HoldingResolver } from './feeds/HoldingResolver';
import { SnapshotWriter } from './feeds/SnapshotWriter';
import { MANUAL_HOLDING_SOURCE } from './holdings/balance-sync-sources';
import { HOLDING_OPEN_OBSERVATION_SOURCE } from './holdings/HoldingService';

interface Destination {
  userId: string;
  account: SyncOwnableAccount;
  tokenId: string;
  /** The transfer's instant: the earliest this write puts on the holding (D-6). */
  at: Date;
}

/**
 * Opens the holding a transfer arrives in, where its account tracks no
 * position in the token yet. The queue's `internal` answer
 * (`TransferReviewService`), a feed's mirror leg (`MirrorLegWriter`) and a
 * transfer its owner declared (`DeclaredTransferService`) all open their
 * destination here, so there is one answer to what it is opened as.
 */
@Service()
export class TransferDestinationOpener {
  private readonly syncOwnership = Container.get(BalanceSyncOwnershipService);
  private readonly resolver = Container.get(HoldingResolver);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly snapshots = Container.get(SnapshotWriter);

  /**
   * Creates the holding, starting at `at`, and returns its id. The arrival
   * itself is the caller's to write.
   *
   * **The two branches are asymmetric on purpose.** On a sync-owned account
   * the row opens at ZERO and the sync writes the real figure on its next
   * pass. An opening observation of 0 would pair with that first sync
   * observation into a gap the ledger cannot explain: the arrival is dated at
   * the TRANSFER's time, before the opening, and `findGapCandidatesForUser`
   * bridges only transactions occurring INSIDE the interval. The owner would
   * be asked to account for money the ledger already accounts for. Where
   * nobody syncs, the opening IS a claim about the balance and belongs on the
   * record (SC-641).
   */
  async open(input: Destination & { quantity: Decimal }, tx: DatabaseTransaction): Promise<string> {
    const { userId, account, quantity } = input;
    const opening = await this.openingOf(userId, account, quantity, tx);
    // Created at an empty cache (D-4); the opening is then set and recorded
    // by the writers.
    const holding = await this.create(input, opening, tx);
    if (opening.balance === '0') return holding.id;
    // The cache first, then the observation: a holding's row lock before the
    // per-holding lock an observation insert takes (R78).
    await this.cacheWriter.apply(userId, [{ holdingId: holding.id, balance: opening.balance }], tx);
    await this.snapshots.record(
      {
        userId,
        holdingId: holding.id,
        amount: opening.balance,
        at: new Date(),
        // The money that moved in, as the holding's first snapshot.
        cause: 'flow',
        legacySource: HOLDING_OPEN_OBSERVATION_SOURCE,
        // The origin `HoldingService.createHoldingWithEvent` stamped on it.
        legacyMeta: { origin: 'createHoldingWithEvent', source: opening.source },
      },
      { cache: 'unchanged' },
      tx
    );
    return holding.id;
  }

  /**
   * The row alone, at an empty cache on either branch, for a transfer its
   * owner declared. Its caller writes the arrival as a flow of its own, which
   * moves the cache from zero, so nothing is opened at the amount here.
   */
  async openEmpty(input: Destination, tx: DatabaseTransaction): Promise<Holding> {
    const opening = await this.openingOf(input.userId, input.account, new Decimal(0), tx);
    return await this.create(input, opening, tx);
  }

  private async create(
    { userId, account, tokenId, at }: Destination,
    opening: { source: string; kind: HoldingKind },
    tx: DatabaseTransaction
  ): Promise<Holding> {
    const row = {
      userId,
      accountId: account.id,
      tokenId,
      source: opening.source,
      // A person was shown this account and picked it, or wrote the rule that
      // names it. That is the whole of what `user_confirmed` claims, and it is
      // true of the row on either branch — only the balance's owner differs.
      arrival: 'user_confirmed' as const,
      at,
    };
    return opening.kind === 'feed'
      ? await this.resolver.createFeedHolding({ ...row, key: null }, tx)
      : await this.resolver.createSnapshotHolding({ ...row, label: null }, tx);
  }

  /** Who states the opened destination's balance decides its figure, its source and its kind. */
  private async openingOf(
    userId: string,
    account: SyncOwnableAccount,
    quantity: Decimal,
    tx: DatabaseTransaction
  ): Promise<{ balance: string; source: string; kind: HoldingKind }> {
    const syncSource = await this.syncOwnership.resolveSyncSource(userId, account, tx);
    if (syncSource) return { balance: '0', source: syncSource, kind: 'feed' };
    // Nobody syncs this account, so the amount that just moved in is the best
    // fact anyone has — and a holding at zero holding a 250 deposit would read
    // as 250 short from the day it was made.
    return { balance: quantity.toFixed(), source: MANUAL_HOLDING_SOURCE, kind: 'snapshot' };
  }
}
