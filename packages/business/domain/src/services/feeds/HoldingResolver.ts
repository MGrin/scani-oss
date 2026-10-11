import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import type { HoldingArrival } from '@scani/shared';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import type { LegacyBatchOptions } from './feed-batch';

interface FeedHoldingRequest {
  userId: string;
  accountId: string;
  tokenId: string;
  /** `holdings.external_id` on create, and what `external-id` finds a holding by. */
  key: string | null;
  match: LegacyBatchOptions['holdingMatch'];
  /** Null finds only. A null `arrival` leaves the column's own default. */
  create: { source: string; arrival: HoldingArrival | null } | null;
  /** The earliest instant the write carries for this holding. */
  at: Date;
}

/**
 * The one `holdings` INSERT on the paths A2 moves (D-4). A row starts with an
 * empty cache and no observation: its first value is the writer's to record,
 * labelled, and the writer then sets the cache (D-1).
 */
@Service()
export class HoldingResolver {
  private readonly holdingRepository = Container.get(HoldingRepository);

  /** A position a person keeps, starting at the write's instant (D-6). */
  async createSnapshotHolding(
    input: {
      userId: string;
      accountId: string;
      tokenId: string;
      label: string | null;
      source: string;
      /** Null leaves the column's own default. */
      arrival: HoldingArrival | null;
      at: Date;
    },
    tx: DatabaseTransaction
  ): Promise<Holding> {
    return await this.holdingRepository.create(
      {
        userId: input.userId,
        accountId: input.accountId,
        tokenId: input.tokenId,
        label: input.label,
        source: input.source,
        ...(input.arrival === null ? {} : { arrival: input.arrival }),
        balance: '0',
        kind: 'snapshot',
        startsAt: input.at,
        lastUpdated: new Date(),
      },
      tx
    );
  }

  /**
   * The holding a feed writes into, by the path's own matching (D-4), or one it
   * creates: a feed position starting at the write's earliest instant (D-6).
   * Null when there is none and `create` is null.
   */
  async resolveFeedHolding(
    req: FeedHoldingRequest,
    tx: DatabaseTransaction
  ): Promise<{ holding: Holding; created: boolean } | null> {
    const found = await this.findFeedHolding(req, tx);
    if (found) return { holding: found, created: false };
    if (req.create === null) return null;
    const holding = await this.createFeedHolding(
      {
        userId: req.userId,
        accountId: req.accountId,
        tokenId: req.tokenId,
        key: req.key,
        ...req.create,
        at: req.at,
      },
      tx
    );
    return { holding, created: true };
  }

  /** A feed position starting at the write's earliest instant (D-6), without looking for one first. */
  async createFeedHolding(
    input: {
      userId: string;
      accountId: string;
      tokenId: string;
      /** `holdings.external_id`. */
      key: string | null;
      source: string;
      /** Null leaves the column's own default. */
      arrival: HoldingArrival | null;
      at: Date;
    },
    tx: DatabaseTransaction
  ): Promise<Holding> {
    return await this.holdingRepository.create(
      {
        userId: input.userId,
        accountId: input.accountId,
        tokenId: input.tokenId,
        source: input.source,
        ...(input.arrival === null ? {} : { arrival: input.arrival }),
        externalId: input.key,
        balance: '0',
        kind: 'feed',
        startsAt: input.at,
        lastUpdated: new Date(),
      },
      tx
    );
  }

  /** The holding a feed writes into, by the path's own matching (D-4); never one it creates. */
  async findFeedHolding(
    req: Pick<FeedHoldingRequest, 'userId' | 'accountId' | 'tokenId' | 'key' | 'match'>,
    tx: DatabaseTransaction | undefined
  ): Promise<Holding | null> {
    const lastSyncHolding = (externalId: string | null, scamFree: boolean) =>
      this.holdingRepository.findLastSyncHolding(
        {
          userId: req.userId,
          accountId: req.accountId,
          tokenId: req.tokenId,
          externalId,
          scamFree,
        },
        tx
      );
    switch (req.match) {
      // F4, the balance syncs': a feed holding, never a snapshot (A5 D-4).
      case 'token-id':
        return lastSyncHolding(null, true);
      case 'token-id-with-scam':
        return lastSyncHolding(null, false);
      case 'external-id-then-token-id':
        return (
          (req.key === null ? null : await lastSyncHolding(req.key, false)) ??
          lastSyncHolding(null, false)
        );
      // F3, the integration import's: the row at the key, hidden ones included.
      case 'external-id':
        if (req.key === null) return Promise.resolve(null);
        return this.holdingRepository.findByAccountTokenAndExternalId(
          req.accountId,
          req.tokenId,
          req.key,
          req.userId,
          tx,
          true
        );
      // F1, the statement import's: the account's oldest visible holding of the
      // token, else its oldest hidden one, which is written rather than
      // duplicated (A5 #9).
      case 'account-token':
        return this.holdingRepository.findByAccountAndToken(
          req.accountId,
          req.tokenId,
          req.userId,
          undefined,
          tx,
          true
        );
      // F2, the transaction import's (SC-193).
      case 'ingest-order':
        return this.holdingRepository.findForIngest(req.accountId, req.tokenId, req.userId, tx);
    }
  }
}
