import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { movedBalance } from '../../../lib/balances/moved-balance';
import { type AdoptedBalanceEdit, arrivalMetadata } from '../../../lib/created-destination';
import { AccountRepository } from '../../../repositories/AccountRepository';
import { FeedInputRepository } from '../../../repositories/FeedInputRepository';
import { HoldingBalanceObservationRepository } from '../../../repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../repositories/HoldingRepository';
import {
  BalanceSyncOwnershipService,
  type SyncOwnableAccount,
} from '../../accounts/BalanceSyncOwnershipService';
import { SYNC_CAPTURE_SOURCE } from '../../foundation/legacy-ledger-kinds';
import { ObservationLabeller } from '../../foundation/ObservationLabeller';
import { TransferDestinationOpener } from '../../TransferDestinationOpener';
import { adoptTypedDeposit, anchorIsUnobserved } from '../../transfer-arrival';
import { deterministicUuid } from '../deterministic-id';
import { HoldingCacheWriter } from '../HoldingCacheWriter';

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

/** Where the leg landed and what it did to the destination, as today's arrival records it. */
interface Landing {
  holdingId: string;
  created: boolean;
  movedAnchor: boolean;
  adopted: AdoptedBalanceEdit | null;
  /** A reused destination's balance copy, which takes its labels once the leg is in place. */
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
  private readonly opener = Container.get(TransferDestinationOpener);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly coverage = Container.get(HoldingCoverageRepository);
  private readonly labeller = Container.get(ObservationLabeller);

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
  ): Promise<SyncOwnableAccount | null> {
    const account = await this.accounts.findByIdAndUser(accountId, userId, tx);
    if (account === null) return null;
    const metadata = account.metadata as Record<string, unknown> | null;
    const walletId = metadata?.userWalletId;
    if (typeof walletId === 'string' && walletId.length > 0) return null;
    if (await this.inputs.accountHasInput(userId, accountId, tx)) return null;
    if ((await this.syncOwnership.resolveSyncSource(userId, account, tx)) !== null) return null;
    return account;
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
      ? await this.reuse(existing, source, quantity, tx)
      : await this.open(destination, source, quantity, tx);
    const { holdingId } = landing;
    const groupId = deterministicUuid(source.inputId, `mirror:${source.rowId}`);
    const externalId = `${source.externalId}:mirror`;
    // Where a replay finds the leg, so the holding it leaves is summarized
    // again too (review M1).
    const prior = await tx
      .select({ holdingId: schema.holdingTransactions.holdingId })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.inputId, source.inputId),
          eq(schema.holdingTransactions.externalId, externalId)
        )
      );

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
        externalId,
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
      // Keyed as every feed row is, by its input (D-7): a replay that finds
      // the leg on another holding moves it to the one it wrote into now,
      // where a (holding, source, external_id) target would insert a second
      // leg the key refuses.
      .onConflictDoUpdate({
        target: [schema.holdingTransactions.inputId, schema.holdingTransactions.externalId],
        set: {
          holdingId,
          tokenId: source.tokenId,
          quantity: quantity.toFixed(),
          occurredAt: source.occurredAt,
          transferGroupId: groupId,
          groupId,
          updatedAt: sql`now()`,
        },
      });
    await this.coverage.syncTxBoundsFromLedger(
      [holdingId, ...prior.map((leg) => leg.holdingId)],
      tx
    );

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

    // The copy's labels, read with the leg in place (D-5).
    if (landing.observationId !== null) {
      await this.labeller.labelAsClassified(source.userId, holdingId, landing.observationId, tx);
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
    const movedAnchor = adopted === null && anchorIsUnobserved(holding);
    let observationId: string | null = null;
    if (movedAnchor) {
      // The engine's balance, under the row lock it takes, not the column read
      // above without one; the copy is evidence, so it goes first (A5 D-15).
      const before = await this.cacheWriter.engineBalance(userId, holding.id, tx);
      const balance = movedBalance(before, quantity);
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
      await this.cacheWriter.apply(userId, [{ holdingId: holding.id, balance }], tx);
    }
    await this.holdings.lowerStartsAt(userId, holding.id, source.occurredAt, tx);
    return { holdingId: holding.id, created: false, movedAnchor, adopted, observationId };
  }

  /** The destination the queue's own answer would open (`TransferDestinationOpener`). */
  private async open(
    account: SyncOwnableAccount,
    source: MirrorSource,
    quantity: Decimal,
    tx: DatabaseTransaction
  ): Promise<Landing> {
    const holdingId = await this.opener.open(
      {
        userId: source.userId,
        account,
        tokenId: source.tokenId,
        quantity,
        at: source.occurredAt,
      },
      tx
    );
    return { holdingId, created: true, movedAnchor: false, adopted: null, observationId: null };
  }
}
