import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { type AdoptedBalanceEdit, arrivalMetadata } from '../../../lib/created-destination';
import { AccountRepository } from '../../../repositories/AccountRepository';
import { EngineEvidenceRepository } from '../../../repositories/EngineEvidenceRepository';
import { FeedInputRepository } from '../../../repositories/FeedInputRepository';
import { HoldingBalanceObservationRepository } from '../../../repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../repositories/HoldingRepository';
import {
  BalanceSyncOwnershipService,
  type SyncOwnableAccount,
} from '../../accounts/BalanceSyncOwnershipService';
import { classifyHoldingEvidence } from '../../foundation/legacy-classification';
import { SYNC_CAPTURE_SOURCE } from '../../foundation/legacy-ledger-kinds';
import type { BalanceSyncSource } from '../../holdings/balance-sync-sources';
import { HOLDING_OPEN_OBSERVATION_SOURCE } from '../../holdings/HoldingService';
import { adoptTypedDeposit, anchorIsUnobserved, openingOf } from '../../transfer-arrival';
import { deterministicUuid } from '../deterministic-id';
import { HoldingCacheWriter } from '../HoldingCacheWriter';
import { HoldingResolver } from '../HoldingResolver';

const MIRROR_LEG_SOURCE = 'feed-mirror';

/** The entry a mirror leg answers: a feed's outflow, as written. */
export interface MirrorSource {
  userId: string;
  /** The account the entry's own holding sits in. */
  accountId: string;
  rowId: string;
  externalId: string;
  inputId: string;
  tokenId: string;
  /** Signed, as stored. */
  amount: string;
  occurredAt: Date;
  counterparty: string | null;
}

export type MirrorLegResult = { holdingId: string; created: boolean } | { notice: string } | null;

/** An account a leg may land in, with the sync source the anchor rule reads. */
interface EligibleDestination {
  account: SyncOwnableAccount;
  syncSource: BalanceSyncSource | null;
}

/** Where the leg landed and what it did to the destination, as today's arrival records it. */
interface Landing {
  holding: Holding;
  created: boolean;
  movedAnchor: boolean;
  adopted: AdoptedBalanceEdit | null;
  /** The balance copy written beside the cache, which takes its labels last. */
  observationId: string | null;
}

/**
 * The other side of a feed → snapshot transfer (spec D8): a `transfer_in` in
 * the destination's snapshot holding, paired with its source by one group.
 * The destination's holding and balance follow the queue's own arrival rule
 * (`transfer-arrival.ts`), so the figure is the one a person answering the
 * queue would have produced.
 */
@Service()
export class MirrorLegWriter {
  private readonly accounts = Container.get(AccountRepository);
  private readonly inputs = Container.get(FeedInputRepository);
  private readonly syncOwnership = Container.get(BalanceSyncOwnershipService);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly resolver = Container.get(HoldingResolver);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly coverage = Container.get(HoldingCoverageRepository);
  private readonly evidence = Container.get(EngineEvidenceRepository);

  /**
   * The user's account, when a mirror leg may land in it (R47): nothing feeds
   * it, no sync owns it and no wallet is linked to it. A feed brings its own
   * arrival, and a leg beside it would count the money twice, since the
   * takeover that retires a queue arrival does not know a mirror leg.
   */
  async eligibleDestination(
    userId: string,
    accountId: string,
    tx: DatabaseTransaction
  ): Promise<EligibleDestination | null> {
    const account = await this.accounts.findByIdAndUser(accountId, userId, tx);
    if (account === null) return null;
    const metadata = account.metadata as Record<string, unknown> | null;
    const walletId = metadata?.userWalletId;
    if (typeof walletId === 'string' && walletId.length > 0) return null;
    if (await this.inputs.accountHasInput(userId, accountId, tx)) return null;
    const syncSource = await this.syncOwnership.resolveSyncSource(account, tx);
    if (syncSource !== null) return null;
    return { account, syncSource };
  }

  /**
   * Writes the leg for an outflow into an eligible account: into its one
   * holding of the asset when that is a snapshot, or into a snapshot holding
   * it opens. A feed holding writes its own arrival, so it gets none; a
   * holding of unknown kind, or two holdings of the asset, get none and a
   * notice (R44). The source becomes `transfer_out`, labelled by rule, and
   * both rows carry the group as `transfer_group_id` too, which is what
   * today's readers pair on (R48). Null where no leg is written.
   */
  async write(
    source: MirrorSource,
    destinationAccountId: string,
    tx: DatabaseTransaction
  ): Promise<MirrorLegResult> {
    const amount = new Decimal(source.amount);
    if (!amount.isNegative() || destinationAccountId === source.accountId) return null;
    const destination = await this.eligibleDestination(source.userId, destinationAccountId, tx);
    if (destination === null) return null;
    const quantity = amount.abs();

    const held = await tx
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, source.userId),
          eq(schema.holdings.accountId, destinationAccountId),
          eq(schema.holdings.tokenId, source.tokenId)
        )
      )
      .orderBy(asc(schema.holdings.id))
      .limit(2);
    const [existing] = held;
    if (held.length > 1) {
      return {
        notice: `mirror-skipped-ambiguous-holding: the arrival of ${source.externalId} was not written, because account ${destinationAccountId} holds that asset in more than one position`,
      };
    }
    if (existing?.kind === 'feed') return null;
    if (existing !== undefined && existing.kind === null) {
      return {
        notice: `mirror-skipped-unknown-kind: the arrival of ${source.externalId} was not written into holding ${existing.id}, whose kind is not known yet`,
      };
    }

    const landing = existing
      ? await this.reuse(existing, source, quantity, destination.syncSource, tx)
      : await this.open(destination.account, source, quantity, tx);
    const holdingId = landing.holding.id;
    const groupId = deterministicUuid(source.inputId, `mirror:${source.rowId}`);

    await tx
      .insert(schema.holdingTransactions)
      .values({
        userId: source.userId,
        holdingId,
        tokenId: source.tokenId,
        kind: 'transfer_in',
        quantity: quantity.toFixed(),
        occurredAt: source.occurredAt,
        source: MIRROR_LEG_SOURCE,
        externalId: `${source.externalId}:mirror`,
        transferGroupId: groupId,
        counterparty: source.counterparty,
        sourceMetadata: arrivalMetadata({
          outflowTransactionId: source.rowId,
          createdDestination: landing.created,
          movedDestinationAnchor: landing.movedAnchor,
          outflowAt: source.occurredAt,
          adoptedBalanceEdit: landing.adopted ?? undefined,
        }),
        inputId: source.inputId,
        ledgerKind: 'transfer_in',
        groupId,
        kindOrigin: 'mirror',
      })
      .onConflictDoUpdate({
        target: [
          schema.holdingTransactions.holdingId,
          schema.holdingTransactions.source,
          schema.holdingTransactions.externalId,
        ],
        set: {
          quantity: quantity.toFixed(),
          occurredAt: source.occurredAt,
          transferGroupId: groupId,
          groupId,
          updatedAt: sql`now()`,
        },
      });
    await this.coverage.syncTxBoundsFromLedger([holdingId], tx);

    await tx
      .update(schema.holdingTransactions)
      .set({
        transferGroupId: groupId,
        ledgerKind: 'transfer_out',
        groupId,
        kindOrigin: 'rule',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.holdingTransactions.id, source.rowId),
          eq(schema.holdingTransactions.userId, source.userId)
        )
      );

    if (landing.observationId !== null) {
      await this.labelObservation(source.userId, holdingId, landing.observationId, tx);
    }
    return { holdingId, created: landing.created };
  }

  /**
   * Today's reused destination: a typed deposit of the same money is taken
   * over, or else the anchor nobody else states moves by the amount, with the
   * balance copy `UpdateHoldingUseCase` writes beside it.
   */
  private async reuse(
    holding: Holding,
    source: MirrorSource,
    quantity: Decimal,
    syncSource: BalanceSyncSource | null,
    tx: DatabaseTransaction
  ): Promise<Landing> {
    const { userId } = source;
    const adopted = await adoptTypedDeposit(
      tx,
      userId,
      holding.id,
      holding.tokenId,
      quantity,
      source.occurredAt
    );
    const movedAnchor = adopted === null && anchorIsUnobserved(holding, syncSource);
    let observationId: string | null = null;
    if (movedAnchor) {
      const balance = new Decimal(holding.balance).add(quantity).toFixed();
      await this.cacheWriter.apply(userId, [{ holdingId: holding.id, balance }], tx);
      const copy = await this.observations.append(
        {
          userId,
          holdingId: holding.id,
          balance,
          observedAt: new Date(),
          source: SYNC_CAPTURE_SOURCE,
          // The origin `UpdateHoldingUseCase` stamps on its copy.
          sourceMetadata: { origin: 'updateHolding' },
        },
        tx
      );
      observationId = copy?.id ?? null;
    }
    await this.holdings.lowerStartsAt(userId, holding.id, source.occurredAt, tx);
    return { holding, created: false, movedAnchor, adopted, observationId };
  }

  /**
   * Today's opened destination: the opening `openingOf` chooses, set as the
   * cache, with the `holding-open` copy `createHoldingWithEvent` writes beside
   * a non-zero one.
   */
  private async open(
    account: SyncOwnableAccount,
    source: MirrorSource,
    quantity: Decimal,
    tx: DatabaseTransaction
  ): Promise<Landing> {
    const { userId } = source;
    const opening = await openingOf(tx, account, quantity);
    const holding = await this.resolver.createSnapshotHolding(
      {
        userId,
        accountId: account.id,
        tokenId: source.tokenId,
        label: null,
        source: opening.source,
        arrival: 'user_confirmed',
        at: source.occurredAt,
      },
      tx
    );
    await this.cacheWriter.apply(userId, [{ holdingId: holding.id, balance: opening.balance }], tx);
    const copy =
      opening.balance === '0'
        ? null
        : await this.observations.append(
            {
              userId,
              holdingId: holding.id,
              balance: opening.balance,
              observedAt: new Date(),
              source: HOLDING_OPEN_OBSERVATION_SOURCE,
              // The origin `HoldingService.createHoldingWithEvent` stamps on its copy.
              sourceMetadata: { origin: 'createHoldingWithEvent', source: opening.source },
            },
            tx
          );
    return {
      holding,
      created: true,
      movedAnchor: false,
      adopted: null,
      observationId: copy?.id ?? null,
    };
  }

  /**
   * The copy's labels, read off A1's classifier with the leg in place rather
   * than restated, so they are the ones the backfill derives (D-5).
   */
  private async labelObservation(
    userId: string,
    holdingId: string,
    observationId: string,
    tx: DatabaseTransaction
  ): Promise<void> {
    const [raw] = await this.evidence.findHoldingEvidence({ userId, holdingIds: [holdingId] }, tx);
    if (raw === undefined) return;
    const { labels } = classifyHoldingEvidence(raw);
    await this.evidence.fillMissingLabels(
      userId,
      [
        {
          holdingId,
          holding: {},
          observations: labels.observations.filter((label) => label.id === observationId),
          entries: [],
        },
      ],
      tx
    );
  }
}
